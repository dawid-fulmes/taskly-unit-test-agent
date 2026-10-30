import ts from 'typescript'
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
    | 'integrity'
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

// ---------------------------------------------------------------------------
// Lexing: blank literals and comments so identifier rules only see code.
// ---------------------------------------------------------------------------

const K = ts.SyntaxKind
const LITERAL_KINDS = new Set<ts.SyntaxKind>([
  K.StringLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.TemplateHead,
  K.TemplateMiddle,
  K.TemplateTail,
  K.RegularExpressionLiteral,
  K.JsxText,
])

interface Lexed {
  /** Same length as the input; string/template/regex/JSX-text contents and comments are spaces. */
  code: string
  /** Parser syntax errors by offset. */
  errors: { offset: number; message: string }[]
  /** Offsets of block comments. */
  blockComments: number[]
  /** Syntax-level test-object tampering found in the AST (see taskTampering). */
  tamper: { offset: number; why: string }[]
}

const TEST_FNS = new Set([
  'it',
  'test',
  'describe',
  'suite',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
])
const REFLECT_OBJECT = new Set([
  'values',
  'entries',
  'keys',
  'getOwnPropertyNames',
  'getOwnPropertyDescriptors',
])
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window'])
// Runner internals: any vitest subpath (vitest/suite, vitest/node, ...) and any @vitest/* package.
const INTERNAL_MODULE = /^(?:vitest\/|@vitest\/)/
const VI_LOADERS = new Set(['importActual', 'importMock', 'mock', 'doMock'])

/** `(x as T)`, `x!`, `(x)`, `<T>x`, `x satisfies T` -> `x`. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n)
  )
    n = n.expression
  return n
}

/** Base identifier of `it.each([...])`, `test.concurrent`, `describe`. */
function calleeRoot(node: ts.Expression): string | null {
  let n = unwrap(node)
  while (
    ts.isPropertyAccessExpression(n) ||
    ts.isElementAccessExpression(n) ||
    ts.isCallExpression(n)
  )
    n = unwrap(n.expression)
  return ts.isIdentifier(n) ? n.text : null
}

/** Names of parameters of functions passed directly to it/test/describe/hooks (the test context). */
function testCallbackParams(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      TEST_FNS.has(calleeRoot(node.expression) ?? '')
    )
      for (const arg of node.arguments) {
        const fn = unwrap(arg)
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
          for (const p of fn.parameters)
            if (ts.isIdentifier(p.name)) names.add(p.name.text)
      }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return names
}

const isStringLike = (n: ts.Node) =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)

/** Module specifier check for static and dynamic loads. */
function badSpecifier(
  arg: ts.Node | undefined,
  mustBeLiteral: boolean,
): boolean {
  if (arg === undefined) return mustBeLiteral
  if (!isStringLike(arg)) return mustBeLiteral
  return INTERNAL_MODULE.test((arg as ts.StringLiteral).text)
}

/** Fix round 2: ways a test reaches its own task object or the runner by reflection. */
function reflectionPaths(
  node: ts.Node,
  contextParams: Set<string>,
  flag: (node: ts.Node, why: string) => void,
): void {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    badSpecifier(node.moduleSpecifier, true)
  )
    flag(node, 'imports vitest runner internals')
  if (ts.isImportEqualsDeclaration(node))
    flag(node, 'import = require is not allowed')
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression)
    const [first] = node.arguments
    if (node.expression.kind === K.ImportKeyword) {
      if (badSpecifier(first, true))
        flag(node, 'dynamic import of a computed or internal module')
    } else if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression)
    ) {
      const obj = callee.expression.text
      const name = callee.name.text
      if (obj === 'vi' && VI_LOADERS.has(name)) {
        const literalOnly = name === 'importActual' || name === 'importMock'
        if (badSpecifier(first, literalOnly))
          flag(node, `vi.${name} of a computed or internal module`)
      }
      if (obj === 'Object' && REFLECT_OBJECT.has(name) && first) {
        const arg = unwrap(first)
        if (
          ts.isIdentifier(arg) &&
          (arg.text === 'arguments' || contextParams.has(arg.text))
        )
          flag(node, `Object.${name} on the test context`)
      }
    }
  }
  if (
    (ts.isPropertyAccessExpression(node) && node.name.text.startsWith('__')) ||
    (ts.isElementAccessExpression(node) &&
      isStringLike(node.argumentExpression) &&
      (node.argumentExpression as ts.StringLiteral).text.startsWith('__'))
  ) {
    const base = unwrap(node.expression)
    if (ts.isIdentifier(base) && GLOBAL_OBJECTS.has(base.text))
      flag(node, 'internal global (__*) access')
  }
  const variableKeyTarget = (target: ts.Expression) => {
    const t = unwrap(target)
    return (
      ts.isElementAccessExpression(t) &&
      !ts.isNumericLiteral(t.argumentExpression) &&
      !isStringLike(t.argumentExpression)
    )
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= K.FirstAssignment &&
    node.operatorToken.kind <= K.LastAssignment &&
    variableKeyTarget(node.left)
  )
    flag(node, 'write through a variable key')
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === K.PlusPlusToken ||
      node.operator === K.MinusMinusToken) &&
    variableKeyTarget(node.operand)
  )
    flag(node, 'write through a variable key')
}

const hasMemberTarget = (node: ts.Node): boolean =>
  ts.isPropertyAccessExpression(node) ||
  ts.isElementAccessExpression(node) ||
  (ts.forEachChild(node, (c) => hasMemberTarget(c) || undefined) ?? false)

/**
 * Shapes that regexes on blanked text cannot see reliably: destructuring the test context's
 * `task` (`({ task }) =>`, `({ task: t })`, `const { task } = ctx`), and writes to members
 * through destructuring assignment (`[t.fails] = [true]`) or a for-in/of target (`for (t.mode of …)`).
 */
function taskTampering(sf: ts.SourceFile): Lexed['tamper'] {
  const out: Lexed['tamper'] = []
  const contextParams = testCallbackParams(sf)
  const flag = (node: ts.Node, why: string) =>
    out.push({ offset: node.getStart(sf), why })
  const visit = (node: ts.Node): void => {
    reflectionPaths(node, contextParams, flag)
    // The parser runs without parent pointers: inspect patterns from the pattern node.
    if (ts.isObjectBindingPattern(node))
      for (const el of node.elements) {
        if (el.propertyName && ts.isComputedPropertyName(el.propertyName))
          flag(el, 'computed key in a destructuring pattern')
        const key = el.propertyName ?? el.name
        if (
          (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
          key.text === 'task'
        )
          out.push({
            offset: el.getStart(sf),
            why: 'destructures the test task object',
          })
      }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === K.EqualsToken &&
      (ts.isArrayLiteralExpression(node.left) ||
        ts.isObjectLiteralExpression(node.left)) &&
      hasMemberTarget(node.left)
    )
      out.push({
        offset: node.getStart(sf),
        why: 'destructuring assignment to a member',
      })
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      hasMemberTarget(node.initializer)
    )
      out.push({
        offset: node.initializer.getStart(sf),
        why: 'for-in/of loop assigns to a member',
      })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Parse `text` with the TypeScript parser (TSX for .tsx) and blank every literal's
 * contents and every comment, preserving offsets and newlines. Literal delimiters stay.
 * Text the parser does not attribute to a token or a comment is kept as code.
 */
function lex(text: string, tsx: boolean): Lexed {
  const sf = ts.createSourceFile(
    tsx ? 'unit.tsx' : 'unit.ts',
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
    },
    false,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out = text.split('')
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '
  }
  const blockComments: number[] = []
  // Only comments are blanked in the trivia between tokens; anything else stays.
  const trivia = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (text.startsWith('//', i)) {
        const nl = text.indexOf('\n', i)
        const e = nl < 0 || nl > to ? to : nl
        blank(i, e)
        i = e
      } else if (text.startsWith('/*', i)) {
        blockComments.push(i)
        const c = text.indexOf('*/', i + 2)
        const e = c < 0 || c + 2 > to ? to : c + 2
        blank(i, e)
        i = e - 1
      }
    }
  }
  let prev = 0
  const visit = (node: ts.Node) => {
    const kids = node.getChildren(sf)
    if (kids.length > 0 && !LITERAL_KINDS.has(node.kind)) {
      kids.forEach(visit)
      return
    }
    if (node.end === node.pos) return
    const start = node.kind === K.JsxText ? node.pos : node.getStart(sf)
    trivia(prev, start)
    prev = node.end
    if (!LITERAL_KINDS.has(node.kind)) return
    const end = node.end
    switch (node.kind) {
      case K.JsxText:
        blank(start, end)
        break
      case K.TemplateHead:
      case K.TemplateMiddle:
        blank(start + 1, end - 2)
        break
      case K.RegularExpressionLiteral:
        blank(start + 1, Math.max(start + 1, text.lastIndexOf('/', end - 1)))
        break
      default:
        blank(
          start + 1,
          (node as ts.LiteralLikeNode).isUnterminated ? end : end - 1,
        )
    }
  }
  visit(sf)
  trivia(prev, text.length)
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics
  const errors = diags
    ? diags.map((d) => ({
        offset: d.start ?? 0,
        message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      }))
    : [{ offset: 0, message: 'parser diagnostics unavailable' }]
  return {
    code: out.join(''),
    errors,
    blockComments,
    tamper: taskTampering(sf),
  }
}

// Whole import statements only; anything else sharing the line is kept and checked.
const IMPORT_STATEMENTS = [
  /(^|\n)[ \t]*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)(?:\s*,\s*\{[^}]*\})?\s*from\s*(['"])[^'"\n]+\2[ \t]*;?[ \t]*(?=\n|$)/g,
  /(^|\n)[ \t]*import\s*(['"])[^'"\n]+\2[ \t]*;?[ \t]*(?=\n|$)/g,
]

/** Contiguous added lines, lexed together. */
interface Unit {
  lines: { line: number; text: string }[]
  raw: string
  code: string
  /** `code` with whole import statements blanked. */
  bare: string
  /** Unit-level findings by offset (mapped to lines when reported). */
  forbidden: { offset: number; why: string }[]
  weakening: { offset: number; why: string }[]
}

const TEST_GLOBALS =
  'it|test|describe|suite|bench|vi|expect|beforeEach|beforeAll|afterEach|afterAll'
const TEST_GLOBAL_NAME = new RegExp(`^(?:${TEST_GLOBALS})$`)
// Strings that must not be used as a computed member key.
const SENSITIVE_KEY =
  /^(?:skip|only|todo|fails|skipIf|runIf|concurrent|sequential|extend|addSnapshotSerializer|addEqualityTesters|chai|Assertion|overwrite\w*|add(?:Method|Property|ChainableMethod)|setState)$/
// Test-context result members (task.result, t.fails, file.tasks, ...) and result hooks.
const RESULT_KEY =
  /^(?:state|errors|result|mode|tasks|task|onTestFailed|onTestFinished|assign|defineProperty|defineProperties|setPrototypeOf)$/
const NON_MEMBER_KEYWORDS =
  /(?:^|[^\w$.])(?:return|of|in|typeof|case|yield|await|else|do|void|delete|throw|instanceof|new|extends)$/

/** Computed member access whose key is assembled from strings, or names a sensitive member. */
function computedMembers(
  code: string,
  raw: string,
): { offset: number; why: string; weakening: boolean }[] {
  const out: { offset: number; why: string; weakening: boolean }[] = []
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '[') continue
    const before = code.slice(0, i).replace(/\s+$/, '')
    const member =
      (/[\w$)\]]$/.test(before) && !NON_MEMBER_KEYWORDS.test(before)) ||
      before.endsWith('?.')
    if (!member) continue
    let depth = 0
    let j = i
    for (; j < code.length; j++) {
      if (code[j] === '[') depth++
      else if (code[j] === ']' && --depth === 0) break
    }
    const key = code.slice(i + 1, j).trim()
    if (!/['"`]/.test(key)) continue
    const single = /^(['"`])[^'"`]*\1$/.test(key) && !key.includes('${')
    if (!single) {
      out.push({
        offset: i,
        why: 'computed member key built from strings',
        weakening: false,
      })
      continue
    }
    const k = raw
      .slice(i + 1, j)
      .trim()
      .slice(1, -1)
    const why = `computed member key ${JSON.stringify(k)}`
    if (SENSITIVE_KEY.test(k)) out.push({ offset: i, why, weakening: false })
    else if (RESULT_KEY.test(k))
      out.push({ offset: i, why: `${why} (test result)`, weakening: true })
  }
  return out
}

/** A whole post-apply file, lexed once; units slice their code from it (R12). */
interface FileContext {
  /** Blanked code split on \n (same line layout as the file). */
  codeLines: string[]
  /** Offset of each line start in the file. */
  lineStart: number[]
  errors: Lexed['errors']
  blockComments: number[]
  tamper: Lexed['tamper']
}

function lexFile(text: string, tsx: boolean): FileContext {
  const { code, errors, blockComments, tamper } = lex(text, tsx)
  const lineStart = [0]
  for (let i = 0; i < text.length; i++)
    if (text[i] === '\n') lineStart.push(i + 1)
  return {
    codeLines: code.split('\n'),
    lineStart,
    errors,
    blockComments,
    tamper,
  }
}

const isTsx = (path: string | null) => /\.tsx$/.test(path ?? '')

/** Lex one unit of added lines: alone, or (modified files after apply) sliced from the whole file. */
function lexUnit(
  lines: FileDiff['added'],
  raw: string,
  tsx: boolean,
  ctx: FileContext | undefined,
): Lexed {
  if (!ctx) return lex(raw, tsx)
  const first = lines[0]!.line
  const base = ctx.lineStart[first - 1]!
  const code = ctx.codeLines
    .slice(first - 1, first - 1 + lines.length)
    .join('\n')
  return {
    code,
    // Whole-file parse errors are reported once by checkApplied.
    errors: [],
    blockComments: ctx.blockComments
      .filter((o) => o >= base && o < base + code.length)
      .map((o) => o - base),
    tamper: ctx.tamper
      .filter((t) => t.offset >= base && t.offset < base + code.length)
      .map((t) => ({ offset: t.offset - base, why: t.why })),
  }
}

function buildUnits(d: FileDiff, ctx?: FileContext): Unit[] {
  const tsx = isTsx(d.newPath)
  const groups: FileDiff['added'][] = []
  for (const l of d.added) {
    const g = groups.at(-1)
    // New files are lexed whole; modified files per contiguous block.
    if (g && (d.status === 'added' || g.at(-1)!.line + 1 === l.line)) g.push(l)
    else groups.push([l])
  }
  return groups.map((lines) => {
    const raw = lines.map((l) => l.text).join('\n')
    const { code, errors, blockComments, tamper } = lexUnit(
      lines,
      raw,
      tsx,
      d.status === 'modified' ? ctx : undefined,
    )
    const weakening = errors.map((e) => ({
      offset: e.offset,
      why: `added code does not parse on its own (${e.message})`,
    }))
    if (d.status === 'modified')
      for (const offset of blockComments)
        weakening.push({ offset, why: 'block comment in existing test file' })
    weakening.push(...tamper)
    const computed = computedMembers(code, raw)
    for (const c of computed)
      if (c.weakening) weakening.push({ offset: c.offset, why: c.why })
    let bare = code
    for (const re of IMPORT_STATEMENTS)
      bare = bare.replace(re, (m: string, lead: string, _q, offset: number) => {
        const stmt = raw.slice(offset + lead.length, offset + m.length)
        const from = /(['"])([^'"\n]+)\1[ \t]*;?[ \t]*$/.exec(stmt)?.[2]
        const names = stmt
          .replace(/(['"])[^'"\n]*\1/g, '')
          .match(/[\w$]+/g)
          ?.filter((n) => TEST_GLOBAL_NAME.test(n))
        if (names?.length && from !== 'vitest')
          weakening.push({
            offset: offset + lead.length,
            why: `test global imported from ${JSON.stringify(from)} instead of vitest`,
          })
        return lead + m.slice(lead.length).replace(/[^\n]/g, ' ')
      })
    return {
      lines,
      raw,
      code,
      bare,
      forbidden: computed
        .filter((c) => !c.weakening)
        .map(({ offset, why }) => ({ offset, why })),
      weakening,
    }
  })
}

const RUNNERS = '(?:it|test|describe|suite|bench)'
// `it[...]`, `it?.[...]` and `it?.(...)` all count as bracket/computed access.
const BRACKET_ACCESS = new RegExp(`\\b${RUNNERS}\\s*(?:\\[|\\?\\.\\s*[[(])`)
const RUNNER_OPTIONAL = new RegExp(`\\b${RUNNERS}\\s*\\?\\.`)
const SKIP_ALIAS =
  /\b(?:it|test|describe|suite)(?:\.\w+)*\.(?:skip|only|todo|fails|skipIf|runIf)\b/

const MODIFIER_STRING =
  /(['"`])(?:skip|only|todo|fails|skipIf|runIf|concurrent|sequential)\1/
const UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}|\\u\{/
const HEX_ESCAPE = /\\x[0-9a-fA-F]{2}/

/**
 * Reasons a chunk of added text declares skipped/focused tests (may span lines).
 * Literal-based checks read `raw`; identifier-based checks read the blanked `code`.
 */
function forbiddenCallReasons(
  raw: string,
  code: string,
  calls: string[],
): string[] {
  const n = normalise(code)
  const r = normalise(raw)
  const out: string[] = []
  const call = calls.find((c) => r.includes(c) || n.includes(c))
  if (call) out.push(call)
  if (BRACKET_ACCESS.test(n)) out.push('bracket access on test function')
  if (RUNNER_OPTIONAL.test(n)) out.push('optional chaining on test function')
  if (SKIP_ALIAS.test(n)) out.push('skip/only/todo/fails modifier')
  if (MODIFIER_STRING.test(raw)) out.push('modifier name used as a string')
  if (UNICODE_ESCAPE.test(raw)) out.push('unicode escape not allowed')
  if (HEX_ESCAPE.test(raw)) out.push('hex escape not allowed')
  return out
}

const SHADOW_DECL = new RegExp(
  `\\b(?:const|let|var|function|class)\\s+(?:${TEST_GLOBALS})\\b`,
)
const SHADOW_ASSIGN = /\b(?:expect|it|test|describe|vi)\s*=(?![=>])/
// Assertion/serializer/equality overrides (expect.extend, chai plugins, ...), as any identifier or member.
const ASSERTION_OVERRIDE =
  /(?<![\w$])(?:extend|addSnapshotSerializer|addEqualityTesters|chai|Assertion|overwrite[\w$]*|add(?:Method|Property|ChainableMethod))(?![\w$])|(?<![\w$])expect\.setState(?![\w$])/
// `= it...` without a direct call; `= vi.x(`/`= vi.x<` and `= expect.x(` are calls, not aliases.
// Simple type arguments directly before a call: `expect<number>(`.
const TYPE_ARGS_CALL = '<[\\w$.,\\s[\\]|]*>\\s*\\('
const CALL_ALIAS = new RegExp(
  `(?<![=!<>])=(?![=>])\\s*(?:${RUNNERS}(?![\\w$])(?!\\s*\\()|(?:vi|expect)(?![\\w$])(?!\\s*(?:\\(|${TYPE_ARGS_CALL}))(?!\\.[A-Za-z_$][\\w$]*\\s*[(<]))`,
)
// Every runner reference must be a call `it(` or member `it.x`; `vi`/`expect` may also
// take simple type arguments before a call (`expect<T>(`).
const RUNNER_VALUE = new RegExp(
  `(?<![\\w$#.])${RUNNERS}(?![\\w$])(?!\\s*(?:\\(|\\.[A-Za-z_$]))`,
  'g',
)
const VI_EXPECT_VALUE = new RegExp(
  `(?<![\\w$#.])(?:vi|expect)(?![\\w$])(?!\\s*(?:\\(|\\.[A-Za-z_$]|${TYPE_ARGS_CALL}))`,
  'g',
)
// Test-context result tampering: result hooks, writes to task state, walking the task tree.
const RESULT_HOOK = /(?<![\w$])(?:onTestFailed|onTestFinished)(?![\w$])/
// `x.state = `, `x.result! = `, `x.state ??= ` (not `!=`, `==`, `<=`, `=>`).
const RESULT_ASSIGN =
  /\.(?:state|errors|result|fails|mode)(?![\w$])\s*(?:!\s+)?(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])/
const TASK_TREE = /\.tasks(?![\w$])/
// Fix round 1: any access to the test task, generic object mutation, and the delete operator.
const TASK_MEMBER = /\.task(?![\w$])/
// `task.result…`, `task!.x`, `task?.x`, `task[…]`: the task object under its usual name.
const TASK_OBJECT = /(?<![\w$.])task\s*(?:!\s*)?(?:\?\.|\.|\[)/
const OBJECT_MUTATION =
  /(?<![\w$.])Object\.(?:assign|defineProperty|defineProperties|setPrototypeOf)(?![\w$])/
const ARGUMENTS = /(?<![\w$.])arguments(?![\w$])/
const REQUIRE = /(?<![\w$.])require(?![\w$])/
// The operator, not `.delete(` calls or a `delete:` object key.
const DELETE_OPERATOR = /(?<![\w$.])delete(?![\w$])(?!\s*:)/
const IMPORT_AS = /\bimport\s*(?:type\s*)?(?:\{[^}]*\bas\s+|\*\s*as\s+)/
const VI_MOCKING =
  /(?<![\w$])vi\.(?:mock|doMock|unmock|doUnmock|stubGlobal|stubEnv)(?![\w$])/
const HOOKS = /(?<![\w$])(?:beforeEach|beforeAll|afterEach|afterAll)(?![\w$])/
const MODIFIED_ONLY: [RegExp, string][] = [
  [VI_MOCKING, 'vi mocking/stubbing'],
  [HOOKS, 'hook in existing test file'],
  [/(?<![\w$.])return(?![\w$])/, 'return statement in existing test file'],
]
// Modified files are lexed per block as if each started in code; if the real insertion
// point is inside an existing multi-line template or JSX text, quoted text could hide
// code. These tokens are therefore also rejected in the raw text of modified files.
const MODIFIED_RAW: [RegExp, string][] = [
  [
    /(?<![\w$])(?:extend|addSnapshotSerializer|addEqualityTesters|chai|Assertion|overwrite(?:Method|Property|ChainableMethod)|add(?:Method|Property|ChainableMethod))(?![\w$])/,
    'assertion override API name in existing test file',
  ],
  [VI_MOCKING, 'vi mocking/stubbing'],
  [HOOKS, 'hook in existing test file'],
  // Inside an existing block comment, a quoted `*/ code /*` would close it and run the code.
  [/\/\*|\*\//, 'block comment marker'],
]

/** Test globals used as values (passed, aliased, cast, compared, ...). Object keys are exempt. */
function usedAsValue(bare: string, perLine: boolean): boolean {
  for (const re of [RUNNER_VALUE, VI_EXPECT_VALUE])
    for (const m of bare.matchAll(re)) {
      const before = bare.slice(0, m.index)
      const after = bare.slice(m.index + m[0].length)
      const keyPos = perLine ? /(?:^|[{,])\s*$/ : /[{,]\s*$/
      if (keyPos.test(before) && /^\s*:/.test(after)) continue
      // A single line may continue with `(` or `.x` on the next one.
      if (perLine && /^\s*$/.test(after)) continue
      return true
    }
  return false
}

/** Reasons a chunk of blanked added code weakens tests (may span lines). */
function weakeningReasons(
  raw: string,
  code: string,
  bare: string,
  modified: boolean,
  perLine: boolean,
): string[] {
  const n = normalise(code)
  const b = normalise(bare)
  const out: string[] = []
  if (SHADOW_DECL.test(n) || SHADOW_ASSIGN.test(n))
    out.push('declares or reassigns a test global')
  if (/\bexpect\.assertions\(\s*0\s*\)/.test(n))
    out.push('expect.assertions(0)')
  if (ASSERTION_OVERRIDE.test(n))
    out.push('assertion override API (extend/chai/serializer) not allowed')
  if (CALL_ALIAS.test(b)) out.push('aliases or destructures a test global')
  if (usedAsValue(b, perLine)) out.push('test global used as a value')
  if (IMPORT_AS.test(n)) out.push('renaming import')
  if (/\bReflect\s*\./.test(n)) out.push('Reflect usage')
  if (RESULT_HOOK.test(n))
    out.push('test result hook (onTestFailed/onTestFinished)')
  if (RESULT_ASSIGN.test(n)) out.push('assignment to a test result member')
  if (TASK_TREE.test(n)) out.push('access to the test task tree (.tasks)')
  if (TASK_MEMBER.test(n) || TASK_OBJECT.test(n))
    out.push('access to the test task object (.task)')
  if (OBJECT_MUTATION.test(n))
    out.push('Object.assign/defineProperty/setPrototypeOf not allowed')
  if (DELETE_OPERATOR.test(n)) out.push('delete operator not allowed')
  if (ARGUMENTS.test(n)) out.push('arguments object not allowed')
  if (REQUIRE.test(n)) out.push('require not allowed')
  // Raw text: also inside strings (`g['__vitest_worker__']`).
  if (/__vitest_/.test(raw)) out.push('vitest internal (__vitest_*) reference')
  if (modified) {
    for (const [re, why] of MODIFIED_ONLY) if (re.test(b)) out.push(why)
    const r = normalise(raw)
    for (const [re, why] of MODIFIED_RAW) if (re.test(r)) out.push(why)
  }
  return [...new Set(out)]
}

/** Line number of `offset` within a unit. */
function lineAt(u: Unit, offset: number): number {
  const idx = u.raw.slice(0, offset).split('\n').length - 1
  return u.lines[Math.min(idx, u.lines.length - 1)]!.line
}

/**
 * Run a per-line check over every unit plus the unit-level findings; when nothing is
 * found per line, run it once over all added lines joined (constructs split across lines).
 */
function lineFindings(
  units: Unit[],
  perLine: (
    raw: string,
    code: string,
    bare: string,
    perLine: boolean,
  ) => string[],
  unitLevel: (u: Unit) => { offset: number; why: string }[],
): { line: number | null; text: string; reasons: string[] }[] {
  const byLine = new Map<number, { text: string; reasons: string[] }>()
  const add = (line: number, text: string, reasons: string[]) => {
    if (reasons.length === 0) return
    const e = byLine.get(line) ?? { text, reasons: [] }
    for (const r of reasons) if (!e.reasons.includes(r)) e.reasons.push(r)
    byLine.set(line, e)
  }
  for (const u of units) {
    const code = u.code.split('\n')
    const bare = u.bare.split('\n')
    u.lines.forEach((l, i) =>
      add(l.line, l.text, perLine(l.text, code[i]!, bare[i]!, true)),
    )
    for (const f of unitLevel(u)) {
      const line = lineAt(u, f.offset)
      add(line, u.lines.find((l) => l.line === line)!.text, [f.why])
    }
  }
  if (byLine.size > 0)
    return [...byLine.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([line, e]) => ({ line, ...e }))
  const join = (k: 'raw' | 'code' | 'bare') => units.map((u) => u[k]).join('\n')
  return perLine(join('raw'), join('code'), join('bare'), false).map((r) => ({
    line: null,
    text: '',
    reasons: [r],
  }))
}

export function checkPatch(
  diffs: FileDiff[],
  policy: Policy,
): { ok: boolean; violations: Violation[] } {
  return checkDiffs(diffs, policy, new Map())
}

/** A test or evidence file as it is on disk after `git apply`, with the lines the patch added. */
export interface AppliedFile {
  path: string
  status: 'added' | 'modified'
  text: string
  added: { line: number; text: string }[]
}

/**
 * R12: re-run the content gates on the files `git apply` produced. New files are gated whole
 * from disk; modified files are lexed whole (so literals and comments are blanked in their real
 * context) and the added-line rules run on the changed lines.
 */
export function checkApplied(
  files: AppliedFile[],
  policy: Policy,
): { ok: boolean; violations: Violation[] } {
  const violations: Violation[] = []
  const diffs: FileDiff[] = []
  const contexts = new Map<string, FileContext>()
  for (const f of files) {
    const add = (rule: Violation['rule'], detail: string) =>
      violations.push({ file: f.path, rule, detail })
    const lines = f.text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    const differs = f.added.find((a) => lines[a.line - 1] !== a.text)
    if (differs) {
      add(
        'integrity',
        `applied content differs from the patch at line ${differs.line}`,
      )
      if (f.status === 'modified') continue
    }
    const base: FileDiff = {
      oldPath: f.status === 'added' ? null : f.path,
      newPath: f.path,
      status: f.status,
      binary: false,
      newMode: null,
      oldMode: null,
      headerMismatch: false,
      malformed: null,
      added: f.added,
      removed: [],
    }
    if (f.status === 'added') {
      if (lines.length !== f.added.length)
        add(
          'integrity',
          `applied file has ${lines.length} lines, the patch adds ${f.added.length}`,
        )
      diffs.push({
        ...base,
        added: lines.map((text, i) => ({ line: i + 1, text })),
      })
      continue
    }
    const ctx = lexFile(f.text, isTsx(f.path))
    for (const e of ctx.errors) {
      const line = ctx.lineStart.findLastIndex((s) => s <= e.offset) + 1
      add(
        'weakening',
        `post-apply file does not parse at line ${line} (${e.message})`,
      )
    }
    contexts.set(f.path, ctx)
    diffs.push(base)
  }
  violations.push(...checkDiffs(diffs, policy, contexts).violations)
  return { ok: violations.length === 0, violations }
}

function checkDiffs(
  diffs: FileDiff[],
  policy: Policy,
  contexts: Map<string, FileContext>,
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

    const units = buildUnits(
      d,
      d.newPath === null ? undefined : contexts.get(d.newPath),
    )
    const modified = d.status === 'modified'
    const report = (
      rule: Violation['rule'],
      found: ReturnType<typeof lineFindings>,
    ) => {
      for (const f of found)
        add(
          rule,
          f.line === null
            ? `across added lines: ${f.reasons.join('; ')}`
            : `line ${f.line}: ${f.reasons.join('; ')} in ${JSON.stringify(f.text.trim())}`,
        )
    }

    report(
      'forbidden-call',
      lineFindings(
        units,
        (raw, code) =>
          forbiddenCallReasons(raw, code, policy.forbiddenTestCalls),
        (u) => u.forbidden,
      ),
    )
    report(
      'snapshot',
      lineFindings(
        units,
        (raw, code) => {
          const r = normalise(raw)
          const n = normalise(code)
          return policy.forbiddenAssertions.filter(
            (c) => r.includes(c) || n.includes(c),
          )
        },
        () => [],
      ),
    )
    // Weakening: added code that neutralises existing or new assertions.
    report(
      'weakening',
      lineFindings(
        units,
        (raw, code, bare, perLine) =>
          weakeningReasons(raw, code, bare, modified, perLine),
        (u) => u.weakening,
      ),
    )

    if (
      d.status === 'added' &&
      d.newPath !== null &&
      (isTestPath(policy, d.newPath) || isEvidencePath(policy, d.newPath)) &&
      !units.some((u) => /\bexpect\s*\(/.test(u.code))
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
