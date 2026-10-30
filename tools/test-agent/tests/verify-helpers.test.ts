import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '../src/policy.ts'
import { expectedFiles, sectionsFor } from '../src/verify/files.ts'
import { appliedPathsCheck, parsePorcelainZ } from '../src/verify/git.ts'
import { addedFileDiff } from './verify-harness.ts'

const policy = loadPolicy()
const T = 'backend/tests/a.test.ts'

describe('parsePorcelainZ', () => {
  it('parses untracked, modified, ignored and rename entries', () => {
    expect(
      parsePorcelainZ(
        `?? ${T}\0 M backend/tests/b.test.ts\0!! backend/node_modules/\0R  backend/tests/new.test.ts\0backend/src/old.ts\0`,
      ),
    ).toEqual([
      { code: '??', path: T, orig: null },
      { code: ' M', path: 'backend/tests/b.test.ts', orig: null },
      { code: '!!', path: 'backend/node_modules/', orig: null },
      {
        code: 'R ',
        path: 'backend/tests/new.test.ts',
        orig: 'backend/src/old.ts',
      },
    ])
    expect(parsePorcelainZ('')).toEqual([])
  })

  it('keeps paths with spaces and newlines intact (-z)', () => {
    expect(parsePorcelainZ('?? backend/tests/a b\nc.test.ts\0')).toEqual([
      { code: '??', path: 'backend/tests/a b\nc.test.ts', orig: null },
    ])
  })

  it('throws on garbage', () => {
    expect(() => parsePorcelainZ('x\0')).toThrow(/unparseable/)
    expect(() => parsePorcelainZ('R  a\0')).toThrow(/without source/)
  })
})

describe('appliedPathsCheck (R6)', () => {
  const e = (code: string, p: string, orig: string | null = null) => ({
    code,
    path: p,
    orig,
  })
  const before = [e('!!', 'backend/node_modules/')]
  const check = (after: ReturnType<typeof e>[], allowed = [T]) =>
    appliedPathsCheck(before, after, new Set(allowed), policy)

  it('accepts exactly the patched test files', () => {
    expect(check([...before, e('??', T)])).toEqual({ ok: true, offending: [] })
  })

  it.each([
    ['a source file', e('??', 'backend/src/x.ts')],
    ['a test file the patch does not name', e('??', 'backend/tests/z.test.ts')],
    ['a deletion', e(' D', T)],
    ['an evidence file', e('??', 'backend/tests/__evidence__/a.test.ts')],
    ['a file hidden by a head .gitignore', e('!!', 'backend/src/x.ts')],
    ['a new ignored directory', e('!!', 'backend/tests/dir/')],
  ])('rejects %s', (_, entry) => {
    const r = check(
      [...before, entry],
      [T, 'backend/tests/__evidence__/a.test.ts'],
    )
    expect(r.ok).toBe(false)
    expect(r.offending).toEqual([entry.path])
  })

  it('rejects both sides of a rename', () => {
    expect(
      check([...before, e('R ', T, 'backend/src/a.ts')]).offending,
    ).toEqual(['backend/src/a.ts', T])
  })

  it('rejects an entry that vanished after apply', () => {
    expect(check([]).offending).toEqual(['backend/node_modules/'])
  })
})

describe('sectionsFor', () => {
  it('returns only the sections touching the file, byte-identical', () => {
    const a = addedFileDiff(T, 'expect(1)\n')
    const b = addedFileDiff(
      'backend/tests/__evidence__/e.test.ts',
      'expect(2)\n',
    )
    expect(sectionsFor(a + b, 'backend/tests/__evidence__/e.test.ts')).toBe(b)
    expect(sectionsFor(a + b, 'backend/tests/none.test.ts')).toBe('')
  })
})

describe('expectedFiles', () => {
  it('applies the base test globs to the tree, skipping evidence, node_modules and symlinks', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'expected-files-'))
    try {
      const files = [
        'backend/tests/a.test.ts',
        'backend/tests/deep/b.test.ts',
        'backend/tests/__evidence__/e.test.ts',
        'backend/tests/fixture.ts',
        'backend/src/c.test.ts',
        'backend/node_modules/x/tests/d.test.ts',
        'frontend/src/f.test.tsx',
      ]
      for (const f of files) {
        await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true })
        await fs.writeFile(path.join(root, f), '')
      }
      await fs.symlink(
        path.join(root, 'backend/tests/a.test.ts'),
        path.join(root, 'backend/tests/link.test.ts'),
      )
      expect(await expectedFiles(fs, root, 'backend', policy)).toEqual([
        'backend/tests/a.test.ts',
        'backend/tests/deep/b.test.ts',
      ])
      expect(await expectedFiles(fs, root, 'frontend', policy)).toEqual([
        'frontend/src/f.test.tsx',
      ])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
