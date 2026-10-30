import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { changedLines, parseUnifiedDiff } from '../src/diff.ts'
import { checkPatch, stripEvidence, testsRemoved } from '../src/gates.ts'
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
