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

/** Reasons a chunk of added text declares skipped/focused tests (may span lines). */
function forbiddenCallReasons(text: string, calls: string[]): string[] {
  const n = normalise(text)
  const out: string[] = []
  const call = calls.find((c) => n.includes(c))
  if (call) out.push(call)
  if (BRACKET_ACCESS.test(n)) out.push('bracket access on test function')
  if (SKIP_ALIAS.test(n)) out.push('skip/only/todo/fails modifier')
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
  [/^\s*return\s*;?\s*$/, 'bare return statement'],
]

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
    for (const l of d.added) {
      const t = l.text
      let why: string | null = null
      if (SHADOW_DECL.test(t) || SHADOW_ASSIGN.test(t))
        why = 'declares or reassigns a test global'
      else if (/\bexpect\s*\.\s*assertions\s*\(\s*0\s*\)/.test(t))
        why = 'expect.assertions(0)'
      else if (d.status === 'modified')
        why = MODIFIED_ONLY.find(([re]) => re.test(t))?.[1] ?? null
      if (why)
        add(
          'weakening',
          `line ${l.line}: ${why} in ${JSON.stringify(t.trim())}`,
        )
    }

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
