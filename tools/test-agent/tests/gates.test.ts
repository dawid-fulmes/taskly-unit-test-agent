import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { changedLines, parseUnifiedDiff } from '../src/diff.ts'
import {
  checkApplied,
  checkPatch,
  stripEvidence,
  testsRemoved,
} from '../src/gates.ts'
import { loadPolicy } from '../src/policy.ts'

const policy = loadPolicy()
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/patches/${name}.diff`, import.meta.url),
    'utf8',
  )
const check = (text: string) => checkPatch(parseUnifiedDiff(text), policy)
const rules = (text: string) => check(text).violations.map((v) => v.rule)

/** Hand-written hostile header that git itself would never emit. */
const handWritten = (path: string, body = '+expect(1)\n') =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}`

describe('parseUnifiedDiff', () => {
  it('returns nothing for empty text', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(check('')).toEqual({ ok: true, violations: [] })
  })

  it('parses added and modified files with line numbers', () => {
    const [added, modified] = parseUnifiedDiff(fixture('clean-additive'))
    expect(added!.status).toBe('added')
    expect(added!.oldPath).toBeNull()
    expect(added!.newPath).toBe('backend/tests/new.test.ts')
    expect(changedLines(added!)).toEqual([1, 2, 3, 4])
    expect(modified!.status).toBe('modified')
    expect(modified!.removed).toEqual([])
    expect(changedLines(modified!)).toEqual([5, 6, 7])
  })

  it('detects renames, symlinks, binary and mode changes', () => {
    const [r] = parseUnifiedDiff(fixture('rename-into-tests'))
    expect(r).toMatchObject({
      status: 'renamed',
      oldPath: 'backend/src/foo.ts',
      newPath: 'backend/tests/foo.test.ts',
    })
    expect(parseUnifiedDiff(fixture('symlink'))[0]!.newMode).toBe('120000')
    expect(parseUnifiedDiff(fixture('binary'))[0]!.binary).toBe(true)
    expect(parseUnifiedDiff(fixture('mode-change'))[0]).toMatchObject({
      status: 'modified',
      oldMode: '100644',
      newMode: '100755',
    })
  })

  it('unquotes git-quoted paths', () => {
    const [d] = parseUnifiedDiff(fixture('quoted-path'))
    expect(d!.newPath).toBe('backend/tests/we ird/é.test.ts')
  })

  it('does not treat added content that looks like headers as structure', () => {
    const text = handWritten(
      'backend/tests/a.test.ts',
      '+expect(1)\n+diff --git a/x b/x\n+GIT binary patch\n',
    ).replace('@@ -0,0 +1 @@', '@@ -0,0 +1,3 @@')
    const diffs = parseUnifiedDiff(text)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.binary).toBe(false)
    expect(diffs[0]!.added).toHaveLength(3)
  })
})

describe('checkPatch', () => {
  it('accepts clean additive patches', () => {
    expect(check(fixture('clean-additive'))).toEqual({
      ok: true,
      violations: [],
    })
  })

  it('accepts evidence paths through the path gate', () => {
    expect(rules(fixture('evidence-mixed'))).toEqual([])
  })

  it.each([
    ['source-path', ['path']],
    ['rename-into-tests', ['rename']],
    ['symlink', ['symlink']],
    ['binary', ['binary']],
    ['mode-change', ['mode']],
    ['new-executable', ['mode']],
    ['mode-change-source', ['path', 'mode']],
    ['deleted-test', ['deleted']],
    ['removed-lines', ['removed-lines']],
    ['forbidden-call', ['forbidden-call', 'forbidden-call']],
    ['snapshot', ['snapshot']],
    ['no-expect', ['no-expect']],
  ])('%s -> %j', (name, expected) => {
    expect(rules(fixture(name!))).toEqual(expected)
  })

  it('rejects renames out of test paths too', () => {
    const v = check(fixture('rename-into-tests')).violations
    expect(v[0]!.detail).toContain('backend/src/foo.ts')
  })

  it('catches forbidden calls with whitespace before the paren', () => {
    const v = check(fixture('forbidden-call')).violations
    expect(v.map((x) => x.detail.split(':')[0])).toEqual(['line 2', 'line 5'])
  })

  it.each([
    ['/etc/passwd'],
    ['backend/tests/../src/x.test.ts'],
    ['../backend/tests/x.test.ts'],
    ['backend/tests/a\u0001b.test.ts'],
    ['backend/tests/a\tb.test.ts'],
  ])('rejects unsafe path %j', (p) => {
    expect(rules(handWritten(p))).toContain('path')
  })

  it('rejects quoted path with an escaped newline', () => {
    const text = `diff --git "a/backend/tests/a\\nb.test.ts" "b/backend/tests/a\\nb.test.ts"\nnew file mode 100644\n--- /dev/null\n+++ "b/backend/tests/a\\nb.test.ts"\n@@ -0,0 +1 @@\n+expect(1)\n`
    expect(rules(text)).toContain('path')
  })

  it('rejects a header that names a different file than ---/+++', () => {
    const text = `diff --git a/backend/src/x.ts b/backend/src/x.ts\nnew file mode 100644\n--- /dev/null\n+++ b/backend/tests/x.test.ts\n@@ -0,0 +1 @@\n+expect(1)\n`
    expect(rules(text)).toContain('path')
  })

  it('rejects deletion detected only via +++ /dev/null', () => {
    const text = `diff --git a/backend/tests/x.test.ts b/backend/tests/x.test.ts\n--- a/backend/tests/x.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-expect(1)\n`
    expect(rules(text)).toEqual(['deleted'])
  })

  it('rejects modification of an existing symlink', () => {
    const text = `diff --git a/backend/tests/l.test.ts b/backend/tests/l.test.ts\nold mode 120000\nnew mode 100644\n`
    expect(rules(text)).toEqual(['symlink'])
  })

  it('rejects a new-file diff of an empty test file (no expect)', () => {
    const text = `diff --git a/backend/tests/e.test.ts b/backend/tests/e.test.ts\nnew file mode 100644\nindex 0000000..e69de29\n`
    expect(rules(text)).toEqual(['no-expect'])
  })
})

describe('checkPatch hostile parser shapes', () => {
  it.each(['probe-p1', 'probe-p2', 'probe-p3', 'probe-p8'])(
    '%s -> path only',
    (name) => {
      const r = check(fixture(name))
      expect(r.ok).toBe(false)
      expect(r.violations.map((v) => v.rule)).toEqual(['path'])
    },
  )

  it('p5: a +++-looking added line is content, not a header', () => {
    const diffs = parseUnifiedDiff(fixture('probe-p5'))
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.added.map((l) => l.text)).toEqual([
      "++ globalThis.n; it.skip('x', () => {})",
      '// end',
    ])
    expect(rules(fixture('probe-p5'))).toEqual(['forbidden-call'])
  })

  it('p7: skip evasions, snapshot variants and assertions(0) are all caught', () => {
    const v = check(fixture('probe-p7')).violations
    expect(v.filter((x) => x.rule === 'forbidden-call')).toHaveLength(4)
    expect(v.map((x) => x.rule)).toContain('snapshot')
    expect(v.map((x) => x.rule)).toContain('weakening')
  })

  it('p9: shadowing expect inside an existing test is weakening', () => {
    expect(rules(fixture('probe-p9'))).toEqual(['weakening'])
  })

  it('whitespace-only text is ok, other text without sections is not', () => {
    expect(check('\n  \n').ok).toBe(true)
    expect(rules('just some text\n')).toEqual(['path'])
  })

  it('rejects text after a hunk and hunks shorter than their counts', () => {
    const head = `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/backend/tests/a.test.ts\n`
    expect(rules(`${head}@@ -0,0 +1 @@\n+expect(1)\n+extra\n`)).toEqual([
      'path',
    ])
    expect(rules(`${head}@@ -0,0 +1,2 @@\n+expect(1)\n`)).toEqual(['path'])
    expect(
      rules(`${head}@@ -0,0 +1 @@\n+expect(1)\n\\ No newline at end of file\n`),
    ).toEqual([])
  })

  it('requires a/ and b/ prefixes on ---/+++ too', () => {
    const t = `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\nnew file mode 100644\n--- /dev/null\n+++ backend/tests/a.test.ts\n@@ -0,0 +1 @@\n+expect(1)\n`
    expect(rules(t)).toContain('path')
  })

  const mod = (line: string) =>
    `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\n--- a/backend/tests/a.test.ts\n+++ b/backend/tests/a.test.ts\n@@ -3,0 +4 @@\n+${line}\n`
  const added = (line: string) =>
    `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/backend/tests/a.test.ts\n@@ -0,0 +1,2 @@\n+expect(1)\n+${line}\n`

  it.each([
    'vi.mock("x")',
    'vi.stubEnv("A", "b")',
    'beforeEach(() => {})',
    '/* hide',
    '  return',
    '  return;',
  ])('modified files reject %j', (line) => {
    expect(rules(mod(line))).toEqual(['weakening'])
  })

  it.each([
    'vi.mock("x")',
    'beforeEach(() => {})',
    '/** doc */',
    'const x = 1',
    'return value',
  ])('new files allow %j', (line) => {
    expect(rules(added(line))).toEqual([])
  })

  it.each([
    'let it = () => {}',
    'function expect() {}',
    'expect = noop',
    'vi = other',
    'expect.assertions(0)',
    'const vi = 1',
  ])('all test files reject %j', (line) => {
    expect(rules(added(line))).toEqual(['weakening'])
  })

  it('does not flag comparisons; runner-named arrow params are rejected', () => {
    expect(rules(added('if (a === b) {}'))).toEqual([])
    expect(rules(added('xs.map(test => test)'))).toEqual(['weakening'])
  })

  it('catches skip aliasing and cross-line modifiers', () => {
    expect(rules(added('const s = it.skip'))).toContain('forbidden-call')
    expect(rules(added("describe.skipIf(x)('a', () => {})"))).toEqual([
      'forbidden-call',
    ])
    expect(rules(added("it['only']('a', () => {})"))).toContain(
      'forbidden-call',
    )
  })
})

describe('checkPatch round 2 bypasses', () => {
  it.each(['r04-cr-split', 'r04-ls-split'])(
    '%s is rejected for the line terminator',
    (name) => {
      const v = check(fixture(name)).violations
      expect(v.map((x) => x.rule)).toContain('path')
      expect(v.some((x) => x.detail.includes('line terminator'))).toBe(true)
    },
  )

  it('rejects U+2029 and a bare CR anywhere', () => {
    const base = fixture('clean-additive')
    expect(rules(base.replace('works', 'wo rks'))).toContain('path')
    expect(rules(base.replace('works', 'wo\rrks'))).toContain('path')
  })

  it('r01: the same path in two sections is rejected', () => {
    const v = check(fixture('r01-dupsection')).violations
    expect(
      v.some(
        (x) => x.rule === 'path' && x.detail.includes('more than one section'),
      ),
    ).toBe(true)
  })

  it('r02: destructuring/aliasing the runner is weakening', () => {
    const v = check(fixture('r02-destructure')).violations
    expect(v.length).toBeGreaterThan(0)
    expect(v.every((x) => x.rule === 'weakening')).toBe(true)
  })

  const mod = (text: string) =>
    `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\n--- a/backend/tests/a.test.ts\n+++ b/backend/tests/a.test.ts\n@@ -3,0 +4,${text.split('\n').length} @@\n${text
      .split('\n')
      .map((l) => '+' + l)
      .join('\n')}\n`
  it.each([
    'beforeEach (() => {})',
    'vi .mock("x")',
    'vi\n  .mock("x")',
    "vi['mock']('x')",
    '  if (x) return',
    'const f = () => { return 1 }',
    'const x = 1; /* a',
    'const x = 1 */',
  ])('modified files reject normalised weakening %j', (text) => {
    expect(rules(mod(text))).toEqual(['weakening'])
  })

  it.each([
    'const { skip } = it',
    'const t = it, u = t.only',
    'const d = describe',
    'x = expect',
    'const m = vi',
  ])('rejects aliasing %j', (text) => {
    expect(rules(mod(text))).toContain('weakening')
  })

  it('still allows vi.fn()/spyOn()/expect.any() assignments', () => {
    expect(rules(mod('const f = vi.fn()'))).toEqual([])
    expect(rules(mod('const s = vi.spyOn(a, "b")'))).toEqual([])
    expect(rules(mod('const m = expect.objectContaining({ a: 1 })'))).toEqual(
      [],
    )
  })
})

describe('checkPatch round 3 bypasses', () => {
  it.each([
    'n01_uesc_skip',
    'n02_uesc_only',
    'n03_uesc_shadow',
    'n04_uesc_alias',
    'n05_paren_alias',
    'n06_vifn_and_alias',
    'n07_import_as',
    'n08_reflect',
    'n09_arrow_arg',
    'm01_uesc_vimock',
    'm02_uesc_hook',
    'm03_optchain_hook',
    'm04_paren_hook',
    'm05_optchain_vimock',
    'm06_optbracket_vi',
  ])('%s is rejected', (name) => {
    const r = check(fixture(name))
    expect(r.ok).toBe(false)
    expect(r.violations.length).toBeGreaterThan(0)
  })

  it('unicode escapes are reported as forbidden-call', () => {
    const v = check(fixture('n01_uesc_skip')).violations
    expect(
      v.some(
        (x) =>
          x.rule === 'forbidden-call' && x.detail.includes('unicode escape'),
      ),
    ).toBe(true)
  })

  const added = (line: string) =>
    `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/backend/tests/a.test.ts\n@@ -0,0 +1,2 @@\n+expect(1)\n+${line}\n`
  const mod = (line: string) =>
    `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\n--- a/backend/tests/a.test.ts\n+++ b/backend/tests/a.test.ts\n@@ -3,0 +4 @@\n+${line}\n`

  it.each([
    'const s = (it)',
    'const s = 0 || it',
    'const s = vi.fn() && it',
    "import { it as t } from 'vitest'",
    "import * as v from 'vitest'",
    "Reflect.get(it, 'skip')",
    "const k = 'skip'",
    'const k = `only`',
    'const k = "skipIf"',
  ])('new files reject %j', (line) => {
    expect(rules(added(line)).length).toBeGreaterThan(0)
  })

  it.each([
    'beforeEach?.(() => {})',
    '(beforeEach)(() => {})',
    'vi?.mock("x")',
    "vi?.['mock']('x')",
    'const h = afterAll',
    'const m = vi',
  ])('modified files reject %j', (line) => {
    expect(rules(mod(line))).toEqual(['weakening'])
  })

  it('does not flag comparisons, object keys, plain imports or call exemptions', () => {
    for (const l of ['if (a === it) {}', 'if (a !== test) {}'])
      expect(rules(added(l))).toEqual(['weakening'])
    for (const l of [
      'if (a <= b || a >= c) {}',
      'const cases = [{ test: 1, it: 2 }]',
      'const f = vi.fn()',
      "const k = 'skipper'",
    ])
      expect(rules(added(l))).toEqual([])
    expect(rules(mod("import { vi } from 'vitest'"))).toEqual([])
    expect(rules(mod('const x = vi.fn()'))).toEqual([])
  })
})

describe('checkPatch round 4 bypasses', () => {
  it.each([
    's01_import_line_parenhook',
    's02_import_line_hookalias',
    's03_ternary_alias_fails',
    's04_optbracket_fails',
    's05_arrow_concat_fails',
    's06_mod_expect_extend',
    's07_mod_ternary_hook',
    's08_mod_import_line_optional',
    's09_mod_hex_string',
    's10_new_ternary_vi_mod',
  ])('%s is rejected', (name) => {
    const r = check(fixture(name))
    expect(r.ok).toBe(false)
    expect(r.violations.length).toBeGreaterThan(0)
  })

  it.each([
    ['s01_import_line_parenhook', 'weakening'],
    ['s02_import_line_hookalias', 'weakening'],
    ['s03_ternary_alias_fails', 'weakening'],
    ['s04_optbracket_fails', 'forbidden-call'],
    ['s06_mod_expect_extend', 'weakening'],
    ['s10_new_ternary_vi_mod', 'weakening'],
  ])('%s reports %s', (name, rule) => {
    expect(rules(fixture(name))).toContain(rule)
  })

  const added = (line: string) =>
    `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/backend/tests/a.test.ts\n@@ -0,0 +1,2 @@\n+expect(1)\n+${line}\n`
  const mod = (line: string) =>
    `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\n--- a/backend/tests/a.test.ts\n+++ b/backend/tests/a.test.ts\n@@ -3,0 +4 @@\n+${line}\n`

  it.each([
    'const s = 1 ? it : 0',
    'const s = 1 ? test: 0',
    'const s = a ? b : describe',
    'const o = { a: 1, b: c ? it : 0 }',
    'run(1 ? it : 0)',
    ';(t => t.x)(it)',
    'wrap(a, test)',
    'const all = [it, test]',
    'expect.extend({ toBe: () => ({ pass: true }) })',
    'expect . extend({})',
    'expect?.extend({})',
    "expect['extend']({})",
    "expect?.['extend']({})",
    'expect.addSnapshotSerializer({})',
    "expect['addSnapshotSerializer']({})",
    "it?.['fa' + 'ils']('z', () => {})",
    "it ?. ['only']('z', () => {})",
    "test?.('z', () => {})",
    'describe?.only',
    "bench?.['skip']('z', () => {})",
    "const k = '\\x73kip'",
  ])('new files reject %j', (line) => {
    expect(rules(added(line)).length).toBeGreaterThan(0)
  })

  it.each([
    "import 'vitest'; (beforeEach)(() => { vi.restoreAllMocks() })",
    "import 'vitest'; const h = afterAll",
    "import 'vitest'; const m = 1 ? vi : 0",
    "import { vi } from 'vitest'; const h = afterEach",
    "import 'vitest' // beforeAll",
    "import { a } from 'b'; vi",
    "expect.extend({ toBe: () => ({ pass: true, message: () => '' }) })",
  ])('modified files reject %j', (line) => {
    expect(rules(mod(line))).toContain('weakening')
  })

  it('does not flag plain imports, object keys or ordinary ternaries', () => {
    for (const l of [
      "import { vi } from 'vitest'",
      "import { describe, expect, it, vi } from 'vitest';",
      "import type { Todo } from '../src/types.ts'",
      "import request, { agent } from 'supertest'",
      "import express from 'express'",
      "import '../src/setup.ts'",
      'const x = vi.fn()',
    ])
      expect(rules(mod(l))).toEqual([])
    for (const l of [
      'const o = { a: 1, it: 2 }',
      'const o = { test: 1 }',
      'const o = {a: 1,describe : 2}',
      'const v = flag ? 1 : 2',
      'expect(flag ? 1 : 2).toBe(1)',
      "it('handles a, b and c', () => {})",
      "test('returns 404, then retries', () => {})",
      "const s = 'extend'",
    ])
      expect(rules(added(l))).toEqual([])
    expect(rules(added('expect(obj.extend).toBeDefined()'))).toEqual([
      'weakening',
    ])
  })
})

describe('checkPatch round 5: blanked literals and assertion overrides', () => {
  const added = (text: string, path = 'frontend/src/a.test.tsx') => {
    const lines = ['expect(1);', ...text.split('\n')]
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`
  }
  const mod = (text: string) => {
    const lines = text.split('\n')
    return `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\n--- a/backend/tests/a.test.ts\n+++ b/backend/tests/a.test.ts\n@@ -3,0 +4,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`
  }

  it('t01: importing chai and overwriting an assertion is rejected', () => {
    expect(rules(fixture('t01_chai_mod'))).toEqual(['weakening', 'weakening'])
  })

  it('t02: a block comment marker hidden in a string of an existing test file is rejected', () => {
    // Inserted inside an existing block comment, `*/` would close it and run the code.
    const v = check(fixture('t02_mod_block_comment_string')).violations
    expect(v.map((x) => x.rule)).toEqual(['weakening'])
    expect(v[0]!.detail).toContain('block comment marker')
  })

  it.each(["const g = 'src/**/*.ts'", '// see /* above', "const s = '*/'"])(
    'modified files reject the raw block comment marker in %j',
    (line) => {
      expect(rules(mod(line))).toContain('weakening')
    },
  )

  it('new files may contain block comment markers in strings', () => {
    expect(check(added("const g = 'src/**/*.ts'")).violations).toEqual([])
  })

  it.each([
    "(expect as any).extend({ toBe: () => ({ pass: true, message: () => '' }) })",
    "(expect!).extend({ toBe: () => ({ pass: true, message: () => '' }) })",
    "chai.Assertion.overwriteMethod('toBe', () => function () {})",
    "chai.use((c) => c.Assertion.overwriteMethod('toEqual', () => function () {}))",
    "import { chai } from 'vitest'",
    'expect.addEqualityTesters([() => true])',
    'expect.setState({ assertionCalls: 1 })',
  ])('modified files reject %j', (line) => {
    expect(rules(mod(line))).toContain('weakening')
  })

  it.each([
    "expect /**/ .extend({ toBe: () => ({ pass: true, message: () => '' }) })",
    'expect\n  .extend({})',
    ";((t: any) => t[['fa', 'ils'].join('')])(it as any)('z', () => { expect(1).toBe(2) })",
    ";((t: any) => t[['sk', 'ip'].join('')])(it!)('z', () => { expect(1).toBe(2) })",
    'wrap(/**/it)',
    'wrap(a,\n  it\n)',
    'const f = (a: unknown) =>\n  a ? it : 0',
    'const v = vi as any',
    'const e = expect<any>',
    'const x = `${it}`',
    "globalThis['expect']['extend']({})",
    "const m = await vi.importActual('vitest'); m['chai']",
    "x['fa' + 'ils']",
    'x[a + `ils`]',
    "it //c\n.skip('x', () => {})",
    "render(<p>Don't</p>); const s = it; '",
    "const r = /'/; const s = it; //'",
    "import { it } from 'node:test'",
    "import test from 'node:test'",
    'Assertion.addMethod("x", () => {})',
    '<<<<<<< HEAD\nconst s = 1\n=======\n>>>>>>> x',
    'const t = `unterminated',
  ])('new files reject %j', (text) => {
    expect(check(added(text)).ok).toBe(false)
  })

  it.each([
    "const db = createDatabase('postgresql://test:test@localhost:5432/test')",
    "const email = 'test@example.com'",
    "const todo = { id: 1, title: 'A test todo', done: false }",
    "const err = new Error('test error')",
    "const label = 'Delete it'",
    'const re = /test/i',
    "expect(screen.getByText('Buy milk (test)')).toBeInTheDocument()",
    "const names = ['a' + suffix]",
    'const mocked = vi.mocked(request)',
    'const mock = vi.mocked(useNotice).mockReturnValue({ notice: null, show: vi.fn() })',
    'const onSave = vi.fn<(t: Todo) => void>()',
    'const timer = vi.advanceTimersByTime(100)',
    'const now = vi.getMockedSystemTime()',
    'const n = expect<number>(1)',
    "await user.type(input, 'test')",
    'const url = `/api/todos?filter=${filter}`',
    'expect(a).toEqual(b) // test it, then extend it',
    '/* it, test and chai */ expect(1).toBe(1)',
    "render(<p>\n  Don't do it\n</p>)",
    'const o = {\n  test: 1,\n  it: 2,\n}',
    "import {\n  describe,\n  expect,\n  it,\n  vi,\n} from 'vitest'",
    "it\n  .each([['all', 3]])('filters %s', (f, n) => { expect(n).toBe(3) })",
    "screen.getAllByRole('row')[1]",
    'const c = mock.calls[0]![0]',
    "type T = Todo['title']",
    "const v = obj['test']",
    "it('x', () => {\n  expect(fmt('it, test')).toBe('a')\n})",
  ])('new files allow %j', (text) => {
    expect(check(added(text)).violations).toEqual([])
  })

  it.each([
    "it('adds', () => {\n  expect(1).toBe(1)\n})",
    "describe('more', () => {\n  it('x', () => {\n    expect(fmt('it')).toBe('a')\n  })\n})",
    "import { vi } from 'vitest'",
    'const f = vi.fn()',
  ])('modified files allow %j', (text) => {
    expect(check(mod(text)).violations).toEqual([])
  })

  it.each([
    '(vi.mock)("x")',
    'vi.doUnmock("x")',
    'const z = `',
    "it('x', () => {\n  expect(1).toBe(1)\n",
    "it('extend the deadline', () => { expect(1).toBe(1) })",
  ])('modified files reject %j', (text) => {
    expect(rules(mod(text))).toContain('weakening')
  })

  it('reports a parse failure as weakening with the parser message', () => {
    const v = check(added('const = 1')).violations
    expect(v).toHaveLength(1)
    expect(v[0]!.rule).toBe('weakening')
    expect(v[0]!.detail).toContain('does not parse')
  })

  it('reports a non-vitest import of a test global on its own line', () => {
    const v = check(
      added("const a = 1\nimport { it } from 'node:test'"),
    ).violations
    expect(v.map((x) => x.detail.split(':')[0])).toEqual(['line 3'])
  })

  it('no-expect ignores expect( inside comments and strings', () => {
    const t = `diff --git a/backend/tests/n.test.ts b/backend/tests/n.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/backend/tests/n.test.ts\n@@ -0,0 +1,2 @@\n+// expect(1)\n+const s = 'expect(1)'\n`
    expect(rules(t)).toEqual(['no-expect'])
  })
})

describe('checkPatch: test-context result tampering', () => {
  const lines = (text: string) => ['expect(1)', ...text.split('\n')]
  const added = (text: string, path = 'backend/tests/a.test.ts') => {
    const l = lines(text)
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${l.length} @@\n${l.map((x) => '+' + x).join('\n')}\n`
  }
  const mod = (text: string) => {
    const l = text.split('\n')
    return `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\n--- a/backend/tests/a.test.ts\n+++ b/backend/tests/a.test.ts\n@@ -3,0 +4,${l.length} @@\n${l.map((x) => '+' + x).join('\n')}\n`
  }
  const weakening = (diff: string) =>
    check(diff).violations.filter((v) => v.rule === 'weakening')

  const tampering = [
    "onTestFailed(({ task }) => { task.result!.state = 'pass' })",
    "import { onTestFinished } from 'vitest'",
    "it('x', ({ onTestFailed }) => { expect(1).toBe(1) })",
    "it('x', (ctx) => { ctx.onTestFinished(() => {}) })",
    "task.result!.state = 'pass'",
    "t.result.state = 'pass'",
    't.fails = true',
    'ctx.task.result.errors = []',
    "ctx.task.mode = 'skip'",
    "t.state ??= 'pass'",
    "t.result! = { state: 'pass' }",
    "t.result\n  .state = 'pass'",
    'const all = ctx.task.file.tasks',
    'const siblings = ctx.task.suite.tasks',
    'for (const x of suite.tasks) x.mode = "skip"',
    "t.result['state'] = 'pass'",
    "ctx['onTestFailed'](() => {})",
    "const s = t['tasks']",
  ]

  it.each(tampering)('new test files reject %j', (text) => {
    expect(weakening(added(text))).not.toEqual([])
  })

  it.each(tampering)('evidence files reject %j', (text) => {
    expect(
      weakening(added(text, 'backend/tests/__evidence__/a.test.ts')),
    ).not.toEqual([])
  })

  it.each(tampering)('modified test files reject %j', (text) => {
    expect(weakening(mod(text))).not.toEqual([])
  })

  it.each([
    'expect(store.state).toBe(1)',
    'expect(res.errors).toEqual([])',
    "if (a.state === 'x') expect(1).toBe(1)",
    "expect(a.state != 'x').toBe(true)",
    "expect(a.mode !== 'x').toBe(true)",
    'expect(a.result <= 1).toBe(true)',
    'const s = { state: 1, errors: [], mode: 2, result: 3 }',
    "const msg = 'onTestFailed and t.fails = true'",
    '// t.result.state = "pass" and ctx.task.file.tasks',
    'const r = response.result',
    'expect(t.tasksDone).toBe(1)',
    "const resultState = 'x'",
  ])('new test files allow %j', (text) => {
    expect(check(added(text)).violations).toEqual([])
  })
})

describe('checkApplied (R12: post-apply full-file context)', () => {
  const existing = [
    "import { expect, it } from 'vitest'",
    "it('x', (t) => {",
    '  const tpl = `a',
    '  b`',
    '  expect(tpl).toBeTruthy()',
    '})',
  ]
  const insert = (at: number, added: string[]) => {
    const lines = [...existing]
    lines.splice(at - 1, 0, ...added)
    return {
      text: lines.join('\n') + '\n',
      added: added.map((text, i) => ({ line: at + i, text })),
    }
  }
  const modDiff = (at: number, added: string[]) =>
    `diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\n--- a/backend/tests/a.test.ts\n+++ b/backend/tests/a.test.ts\n@@ -${at - 1},0 +${at},${added.length} @@\n${added.map((l) => '+' + l).join('\n')}\n`

  it('accepts a clean modification', () => {
    const add = ['  expect(1).toBe(1)']
    expect(check(modDiff(5, add)).ok).toBe(true)
    const { text, added } = insert(5, add)
    expect(
      checkApplied(
        [{ path: 'backend/tests/a.test.ts', status: 'modified', text, added }],
        policy,
      ),
    ).toEqual({ ok: true, violations: [] })
  })

  it('sees code that per-block lexing takes for a string (inside an existing template)', () => {
    const add = ["' ${(t.fails = true)} '"]
    // The patch gate lexes the block alone: a plain string, nothing to flag.
    expect(check(modDiff(4, add)).violations).toEqual([])
    const { text, added } = insert(4, add)
    const r = checkApplied(
      [{ path: 'backend/tests/a.test.ts', status: 'modified', text, added }],
      policy,
    )
    expect(r.ok).toBe(false)
    expect(r.violations.map((v) => v.rule)).toEqual(['weakening'])
    expect(r.violations[0]!.detail).toContain('test result member')
  })

  it('applies the modified-file rules to the changed lines', () => {
    const { text, added } = insert(5, ['  beforeEach(() => {})'])
    expect(
      checkApplied(
        [{ path: 'backend/tests/a.test.ts', status: 'modified', text, added }],
        policy,
      ).violations.map((v) => v.rule),
    ).toEqual(['weakening'])
  })

  it('rejects a post-apply file that does not parse', () => {
    const { text, added } = insert(5, ['  expect(1).toBe(1)'])
    const broken = text.replace('})\n', '})) +\n')
    const r = checkApplied(
      [
        {
          path: 'backend/tests/a.test.ts',
          status: 'modified',
          text: broken,
          added,
        },
      ],
      policy,
    )
    expect(r.violations.map((v) => v.rule)).toContain('weakening')
    expect(r.violations.map((v) => v.detail).join()).toContain('does not parse')
  })

  it('rejects applied content that differs from the patch', () => {
    const { text, added } = insert(5, ['  expect(1).toBe(1)'])
    const r = checkApplied(
      [
        {
          path: 'backend/tests/a.test.ts',
          status: 'modified',
          text,
          added: [{ line: 5, text: '  expect(2).toBe(2)' }],
        },
      ],
      policy,
    )
    expect(r.violations).toEqual([
      {
        file: 'backend/tests/a.test.ts',
        rule: 'integrity',
        detail: 'applied content differs from the patch at line 5',
      },
    ])
    void added
  })

  it('gates new files as whole files from disk', () => {
    const text =
      "import { expect, it } from 'vitest'\nit('x', () => { expect(1).toBe(1) })\n"
    const added = text
      .split('\n')
      .slice(0, 2)
      .map((t, i) => ({ line: i + 1, text: t }))
    expect(
      checkApplied(
        [{ path: 'backend/tests/n.test.ts', status: 'added', text, added }],
        policy,
      ),
    ).toEqual({ ok: true, violations: [] })
    const extra = text + "it.skip('y', () => {})\n"
    expect(
      checkApplied(
        [
          {
            path: 'backend/tests/n.test.ts',
            status: 'added',
            text: extra,
            added,
          },
        ],
        policy,
      ).violations.map((v) => v.rule),
    ).toEqual(['integrity', 'forbidden-call'])
  })
})

describe('checkPatch on the repository test files', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const files = ['backend/tests', 'frontend/src'].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.test\.tsx?$/.test(f) && !f.includes('node_modules'))
      .map((f) => `${dir}/${f.split(sep).join('/')}`),
  )

  it('finds the existing test files', () => {
    expect(files.length).toBeGreaterThanOrEqual(18)
  })

  it.each(files)('%s passes as a newly added file', (path) => {
    const lines = readFileSync(join(root, path), 'utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
    const diff = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`
    expect(check(diff)).toEqual({ ok: true, violations: [] })
  })
})

describe('stripEvidence', () => {
  it('drops evidence sections and keeps the rest byte-identical', () => {
    const text = fixture('evidence-mixed')
    const out = stripEvidence(text, policy)
    expect(out).not.toContain('__evidence__')
    expect(out).toContain('backend/tests/keep.test.ts')
    const keep = text.slice(text.indexOf('diff --git a/backend/tests/keep'))
    expect(out).toBe(keep)
  })

  it('returns text unchanged when there is no evidence', () => {
    const text = fixture('clean-additive')
    expect(stripEvidence(text, policy)).toBe(text)
    expect(stripEvidence('', policy)).toBe('')
  })
})

describe('testsRemoved', () => {
  it('counts it/test/it.each in a deleted test file', () => {
    expect(
      testsRemoved(parseUnifiedDiff(fixture('deleted-test')), policy),
    ).toEqual([{ file: 'backend/tests/old.test.ts', count: 3 }])
  })

  it('counts removed declarations in a modified test file', () => {
    expect(
      testsRemoved(parseUnifiedDiff(fixture('removed-lines')), policy),
    ).toEqual([{ file: 'backend/tests/old.test.ts', count: 2 }])
  })

  it('ignores clean patches and non-test files', () => {
    expect(
      testsRemoved(parseUnifiedDiff(fixture('clean-additive')), policy),
    ).toEqual([])
    expect(
      testsRemoved(parseUnifiedDiff(fixture('source-path')), policy),
    ).toEqual([])
  })
})
