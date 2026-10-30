import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { discoveryMismatch, readVitestJson } from '../src/vitest-results.ts'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'))

describe('readVitestJson', () => {
  it('flags real assertion failures as assertions, and others not', () => {
    const r = readVitestJson(fixture('vitest-assertions.json'), 'backend')
    expect(r.files).toEqual(['backend/tests/assert.test.ts'])
    expect(r.total).toBe(7)
    expect(r.passed).toBe(0)
    expect(r.failed).toBe(7)
    const byName = Object.fromEntries(r.failures.map((f) => [f.name, f]))
    for (const n of [
      'assertion fail',
      'deep fail',
      'match fail',
      'thrown assert',
      'explicit',
    ])
      expect(byName[n]?.isAssertion, n).toBe(true)
    for (const n of ['typeerror', 'thrown error'])
      expect(byName[n]?.isAssertion, n).toBe(false)
    expect(byName['assertion fail']).toMatchObject({
      file: 'backend/tests/assert.test.ts',
      message: expect.stringContaining('expected 1 to be 2'),
    })
  })

  it('treats a TypeError as non-assertion', () => {
    const r = readVitestJson(fixture('vitest-assertions.json'), 'backend')
    const f = r.failures.find((x) => x.name === 'typeerror')
    expect(f?.message.startsWith('TypeError')).toBe(true)
    expect(f?.isAssertion).toBe(false)
  })

  it('reports a file that fails to load as a non-assertion failure', () => {
    const r = readVitestJson(fixture('vitest-import-error.json'), 'backend')
    expect(r.files).toEqual(['backend/tests/importerr.test.ts'])
    expect(r.failed).toBe(1)
    expect(r.passed).toBe(0)
    expect(r.failures).toEqual([
      {
        file: 'backend/tests/importerr.test.ts',
        name: '(file failed to load)',
        isAssertion: false,
        message: expect.stringContaining('Cannot find module'),
      },
    ])
  })

  it('reports a top-level throw as a non-assertion failure', () => {
    const r = readVitestJson(fixture('vitest-top-level-error.json'), 'backend')
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]?.isAssertion).toBe(false)
    expect(r.failures[0]?.message).toBe('top level failure')
  })

  it('exposes every test, skip, todo and per-file passed counts', () => {
    const r = readVitestJson(fixture('vitest-skip-todo-fails.json'), 'backend')
    expect(r).toMatchObject({
      files: ['backend/tests/ok.test.ts'],
      total: 7,
      passed: 4,
      failed: 0,
      skipped: 2,
      todo: 1,
      passedByFile: { 'backend/tests/ok.test.ts': 4 },
      failures: [],
    })
    expect(r.tests.map((t) => `${t.status}:${t.name}`)).toEqual([
      'passed:math add adds',
      'passed:math sign pos',
      'skipped:math skipped one',
      'todo:math todo one',
      'passed:math fails mode',
      'passed:math runtime fails',
      'skipped:math conditionally skipped',
    ])
    expect(r.tests.every((t) => t.file === 'backend/tests/ok.test.ts')).toBe(
      true,
    )
  })

  it('cannot observe fails-mode from the JSON reporter, so failsMode stays empty', () => {
    // `it.fails` and a runtime `task.fails = true` both appear as plain "passed" with empty meta.
    const r = readVitestJson(fixture('vitest-skip-todo-fails.json'), 'backend')
    expect(r.failsMode).toEqual([])
  })

  it('normalises container paths per app', () => {
    const json = {
      testResults: [
        {
          name: '/app/src/a.test.tsx',
          status: 'passed',
          message: '',
          assertionResults: [],
        },
      ],
    }
    expect(readVitestJson(json, 'frontend').files).toEqual([
      'frontend/src/a.test.tsx',
    ])
  })

  it('rejects malformed input and paths outside the app root (fail closed)', () => {
    expect(() => readVitestJson(null, 'backend')).toThrow()
    expect(() => readVitestJson({}, 'backend')).toThrow()
    expect(() =>
      readVitestJson(
        {
          testResults: [
            { name: '/etc/x.test.ts', status: 'passed', assertionResults: [] },
          ],
        },
        'backend',
      ),
    ).toThrow(/outside/)
    expect(() =>
      readVitestJson(
        {
          testResults: [
            {
              name: '/app/../etc/x.test.ts',
              status: 'passed',
              assertionResults: [],
            },
          ],
        },
        'backend',
      ),
    ).toThrow(/outside/)
    expect(() =>
      readVitestJson(
        {
          testResults: [
            {
              name: '/app/tests/x.test.ts',
              status: 'passed',
              assertionResults: [{ status: 'passed' }],
            },
          ],
        },
        'backend',
      ),
    ).toThrow()
  })
})

describe('discoveryMismatch', () => {
  it('returns expected files that were not executed', () => {
    expect(discoveryMismatch(['a', 'b'], ['a'])).toEqual(['b'])
    expect(discoveryMismatch(['a'], ['a', 'c'])).toEqual([])
  })
})
