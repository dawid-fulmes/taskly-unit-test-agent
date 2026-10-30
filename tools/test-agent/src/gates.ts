import { parseUnifiedDiff, splitSections, type FileDiff } from './diff.ts'
import { isEvidencePath, isTestPath, type Policy } from './policy.ts'

export interface Violation {
  file: string
  rule:
    | 'path'
    | 'deleted'
    | 'removed-lines'
    | 'forbidden-call'
    | 'snapshot'
    | 'no-expect'
    | 'binary'
    | 'symlink'
    | 'rename'
    | 'mode'
    | 'weakening'
  detail: string
}

const NORMAL_MODE = '100644'
const SYMLINK_MODE = '120000'

/** Absolute, traversing or control-character paths are never acceptable. */
function unsafePath(path: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'control character in path'
  if (path === '') return 'empty path'
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\'))
    return 'absolute or non-POSIX path'
  if (path.split('/').some((s) => s === '..')) return 'path traversal'
  return null
}

/** Collapse whitespace around `.` and before `(` (newlines included) so `it . only\n(` matches `.only(`. */
function normalise(text: string): string {
  return text.replace(/\s*\.\s*/g, '.').replace(/\s+\(/g, '(')
}

const RUNNERS = '(?:it|test|describe|suite|bench)'
const BRACKET_ACCESS = new RegExp(`\\b${RUNNERS}\\s*\\[`)
const SKIP_ALIAS =
  /\b(?:it|test|describe|suite)(?:\.\w+)*\.(?:skip|only|todo|fails|skipIf|runIf)\b/

const MODIFIER_STRING =
  /(['"`])(?:skip|only|todo|fails|skipIf|runIf|concurrent|sequential)\1/
const UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}|\\u\{/

/** Reasons a chunk of added text declares skipped/focused tests (may span lines). */
function forbiddenCallReasons(text: string, calls: string[]): string[] {
  const n = normalise(text)
  const out: string[] = []
  const call = calls.find((c) => n.includes(c))
  if (call) out.push(call)
  if (BRACKET_ACCESS.test(n)) out.push('bracket access on test function')
  if (SKIP_ALIAS.test(n)) out.push('skip/only/todo/fails modifier')
  if (MODIFIER_STRING.test(text)) out.push('modifier name used as a string')
  if (UNICODE_ESCAPE.test(text)) out.push('unicode escape not allowed')
  return out
}

const GLOBALS =
  'expect|it|test|describe|vi|beforeEach|afterEach|beforeAll|afterAll'
const SHADOW_DECL = new RegExp(
  `\\b(?:const|let|var|function|class)\\s+(?:${GLOBALS})\\b`,
)
const SHADOW_ASSIGN = /\b(?:expect|it|test|describe|vi)\s*=(?![=>])/
const MODIFIED_ONLY: [RegExp, string][] = [
  [/\bvi\.(?:mock|doMock|unmock|stubGlobal|stubEnv)\(/, 'vi mocking/stubbing'],
  [
    /\b(?:beforeEach|beforeAll|afterEach|afterAll)\(/,
    'hook added to existing test file',
  ],
  [/\/\*|\*\//, 'block comment marker'],
  [/\breturn\b/, 'return statement in existing test file'],
  [/\bvi\s*\[/, 'bracket access on vi'],
]

const NAMES = 'it|test|describe|suite|bench|vi|expect'
// Assignment `=` that is not part of ==, ===, !=, !==, <=, >=, =>.
const ASSIGN_RHS = /(?<![=!<>])=(?![=>])([^;\n]*)/g
// Bare reference to a test global: not a property (`.it`), not a call/member, not an object key.
const BARE_GLOBAL = new RegExp(`(?<![.\\w$])(?:${NAMES})\\b(?!\\s*[.(:])`)
const CALL_ALIAS = new RegExp(
  `(?<![=!<>])=(?![=>])\\s*(?:${NAMES})\\b(?!\\s*\\()(?!\\.(?:fn|spyOn)\\()(?!\\.(?:any|anything|objectContaining|arrayContaining|stringContaining|stringMatching)\\()`,
)
const IMPORT_AS = /\bimport\s*(?:type\s*)?(?:\{[^}]*\bas\s+|\*\s*as\s+)/
const HOOK_TOKENS = 'beforeEach|beforeAll|afterEach|afterAll|vi'
const HOOK_OPTIONAL = new RegExp(`\\b(?:${HOOK_TOKENS})\\s*\\?\\.`)
const HOOK_BARE = new RegExp(`(?<![.\\w$])(?:${HOOK_TOKENS})\\b(?!\\s*[.(])`)

function aliasesGlobal(n: string): boolean {
  if (CALL_ALIAS.test(n)) return true
  for (const m of n.matchAll(ASSIGN_RHS))
    if (BARE_GLOBAL.test(m[1]!)) return true
  return false
}

/** Reasons a chunk of added text weakens tests (may span lines). */
function weakeningReasons(text: string, modified: boolean): string[] {
  const n = normalise(text)
  const out: string[] = []
  if (SHADOW_DECL.test(n) || SHADOW_ASSIGN.test(n))
    out.push('declares or reassigns a test global')
  if (/\bexpect\.assertions\(\s*0\s*\)/.test(n))
    out.push('expect.assertions(0)')
  if (aliasesGlobal(n)) out.push('aliases or destructures a test global')
  if (IMPORT_AS.test(n)) out.push('renaming import')
  if (/\bReflect\s*\./.test(n)) out.push('Reflect usage')
  if (modified) {
    for (const [re, why] of MODIFIED_ONLY) if (re.test(n)) out.push(why)
    const body = n
      .split('\n')
      .filter((l) => !/^\s*import\b/.test(l))
      .join('\n')
    if (HOOK_OPTIONAL.test(n) || HOOK_BARE.test(body))
      out.push('indirect hook/vi reference in existing test file')
  }
  return out
}

export function checkPatch(
  diffs: FileDiff[],
  policy: Policy,
): { ok: boolean; violations: Violation[] } {
  const violations: Violation[] = []

  for (const d of diffs) {
    const file = d.newPath ?? d.oldPath ?? '(unknown)'
    const add = (rule: Violation['rule'], detail: string) =>
      violations.push({ file, rule, detail })

    if (d.malformed)
      add('path', `unparsed or malformed diff content: ${d.malformed}`)

    // Path gate: every named path must be safe and an allowed test/evidence file.
    let pathsOk = true
    const named = [...new Set([d.oldPath, d.newPath])].filter(
      (p): p is string => p !== null,
    )
    if (named.length === 0 && !d.malformed) {
      add('path', 'diff section has no usable path')
      pathsOk = false
    }
    if (d.headerMismatch) {
      add('path', 'diff header paths disagree with ---/+++ paths')
      pathsOk = false
    }
    for (const p of named) {
      const bad = unsafePath(p)
      if (bad) {
        add('path', `${bad}: ${JSON.stringify(p)}`)
        pathsOk = false
      }
    }

    if (d.status === 'renamed') {
      // Any rename/copy is rejected outright; its path is moot.
      add('rename', `${d.oldPath ?? '?'} -> ${d.newPath ?? '?'}`)
      continue
    }
    if (pathsOk) {
      for (const p of named)
        if (!isTestPath(policy, p) && !isEvidencePath(policy, p))
          add('path', `not a test or evidence file: ${p}`)
    }

    if (d.status === 'deleted') {
      add('deleted', `file deleted: ${d.oldPath}`)
      continue
    }
    if (d.binary) {
      add('binary', 'binary change')
      continue
    }
    if (d.newMode === SYMLINK_MODE || d.oldMode === SYMLINK_MODE) {
      add('symlink', 'symlink (mode 120000)')
      continue
    }
    if (d.status === 'modified' && d.newMode !== null)
      add('mode', `mode change ${d.oldMode ?? '?'} -> ${d.newMode}`)
    else if (
      d.status === 'added' &&
      d.newMode !== null &&
      d.newMode !== NORMAL_MODE
    )
      add('mode', `new file mode ${d.newMode}`)

    if (d.status === 'modified' && d.removed.length > 0)
      add(
        'removed-lines',
        `${d.removed.length} line(s) removed from existing file (first at line ${d.removed[0]!.line})`,
      )

    let flagged = false
    for (const l of d.added) {
      const reasons = forbiddenCallReasons(l.text, policy.forbiddenTestCalls)
      if (reasons.length > 0) {
        flagged = true
        add(
          'forbidden-call',
          `line ${l.line}: ${reasons.join('; ')} in ${JSON.stringify(l.text.trim())}`,
        )
      }
    }
    if (!flagged && d.added.length > 0) {
      // Constructs split across lines (`it.skip\n('x')`).
      const joined = d.added.map((l) => l.text).join('\n')
      for (const r of forbiddenCallReasons(joined, policy.forbiddenTestCalls))
        add('forbidden-call', `across added lines: ${r}`)
    }

    let snapFlagged = false
    for (const l of d.added) {
      const snap = policy.forbiddenAssertions.find((c) =>
        normalise(l.text).includes(c),
      )
      if (snap) {
        snapFlagged = true
        add(
          'snapshot',
          `line ${l.line}: ${snap} in ${JSON.stringify(l.text.trim())}`,
        )
      }
    }
    if (!snapFlagged) {
      const n = normalise(d.added.map((l) => l.text).join('\n'))
      const snap = policy.forbiddenAssertions.find((c) => n.includes(c))
      if (snap) add('snapshot', `across added lines: ${snap}`)
    }

    // Weakening: added lines that neutralise existing or new assertions.
    let weak = false
    for (const l of d.added) {
      const reasons = weakeningReasons(l.text, d.status === 'modified')
      if (reasons.length > 0) {
        weak = true
        add(
          'weakening',
          `line ${l.line}: ${reasons.join('; ')} in ${JSON.stringify(l.text.trim())}`,
        )
      }
    }
    if (!weak && d.added.length > 0)
      for (const r of weakeningReasons(
        d.added.map((l) => l.text).join('\n'),
        d.status === 'modified',
      ))
        add('weakening', `across added lines: ${r}`)

    if (
      d.status === 'added' &&
      d.newPath !== null &&
      (isTestPath(policy, d.newPath) || isEvidencePath(policy, d.newPath)) &&
      !d.added.some((l) => /\bexpect\s*\(/.test(l.text))
    )
      add('no-expect', 'new test file contains no expect(')
  }

  return { ok: violations.length === 0, violations }
}

/** Remove evidence file sections from raw diff text; everything else stays byte-identical. */
export function stripEvidence(diffText: string, policy: Policy): string {
  const { preamble, sections } = splitSections(diffText)
  // parseUnifiedDiff prepends a pseudo entry for preamble text; align to sections.
  const all = parseUnifiedDiff(diffText)
  const parsed = all.slice(all.length - sections.length)
  const kept = sections.filter((_, i) => {
    const d = parsed[i]!
    return ![d.oldPath, d.newPath].some(
      (p) => p !== null && isEvidencePath(policy, p),
    )
  })
  return preamble + kept.map((s) => s.raw).join('')
}

const TEST_DECL = /\b(it|test)(\.each\([^)]*\))?\s*\(/

export function testsRemoved(
  diffs: FileDiff[],
  policy: Policy,
): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = []
  for (const d of diffs) {
    const file = [d.oldPath, d.newPath].find(
      (p): p is string => p !== null && isTestPath(policy, p),
    )
    if (!file) continue
    const count = d.removed.filter((l) => TEST_DECL.test(l.text)).length
    if (count > 0) out.push({ file, count })
  }
  return out
}
