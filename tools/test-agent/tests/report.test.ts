import { describe, expect, it } from 'vitest'
import { validateReport } from '../src/report.ts'

const valid = () => ({
  files: [
    {
      path: 'backend/src/a.ts',
      action: 'create',
      testFile: 'backend/tests/a.test.ts',
    },
    {
      path: 'backend/src/b.ts',
      action: 'skip',
      skip: { file: 'backend/tests/b.test.ts', testName: 'covers b' },
    },
    {
      path: 'backend/src/c.ts',
      action: 'skip',
      skip: { reason: 'excluded-from-coverage' },
    },
  ],
  behaviours: [
    {
      file: 'backend/src/a.ts',
      description: 'returns 422',
      source: { kind: 'openapi', ref: '/paths/~1x' },
    },
  ],
  defects: [
    {
      file: 'backend/src/a.ts',
      evidenceTest: 'backend/tests/__evidence__/a.test.ts',
      summary: 'bad',
      citation: { kind: 'openapi', pointer: '/paths/~1x' },
    },
    {
      file: 'backend/src/a.ts',
      evidenceTest: 'backend/tests/__evidence__/a.test.ts',
      summary: 'bad',
      citation: { kind: 'pr-description', quote: 'a long enough quote' },
    },
  ],
  narrative: 'done',
})

const bad = (mutate: (r: any) => void) => {
  const r = valid()
  mutate(r)
  return validateReport(r)
}

describe('validateReport', () => {
  it('accepts a valid report', () => {
    const r = validateReport(valid())
    expect(r.ok).toBe(true)
  })
  it('rejects non-objects', () => {
    expect(validateReport(null).ok).toBe(false)
    expect(validateReport([]).ok).toBe(false)
  })
  it('rejects extra properties', () => {
    expect(bad((r) => (r.extra = 1)).ok).toBe(false)
    expect(bad((r) => (r.files[0].extra = 1)).ok).toBe(false)
    expect(bad((r) => (r.defects[0].citation.extra = 1)).ok).toBe(false)
  })
  it('rejects bad enums and empty strings', () => {
    expect(bad((r) => (r.files[0].action = 'delete')).ok).toBe(false)
    expect(bad((r) => (r.behaviours[0].source.kind = 'x')).ok).toBe(false)
    expect(bad((r) => (r.behaviours[0].description = '')).ok).toBe(false)
  })
  it('rejects non-relative paths', () => {
    for (const p of ['/etc/passwd', '../x.ts', 'a/../b.ts', 'a\\b.ts', 'a\nb'])
      expect(bad((r) => (r.files[0].path = p)).ok, p).toBe(false)
    expect(bad((r) => (r.files[0].testFile = '/abs')).ok).toBe(false)
    expect(bad((r) => (r.defects[0].evidenceTest = '../e')).ok).toBe(false)
    expect(bad((r) => (r.files[1].skip.file = '../e')).ok).toBe(false)
    expect(bad((r) => (r.files[0].path = 'a/..b/c.ts')).ok).toBe(true)
  })
  it('rejects non-canonical paths', () => {
    for (const p of ['.', './x.ts', 'a/./b.ts', 'a//b.ts', 'a/', '..', 'a/..'])
      expect(bad((r) => (r.files[0].path = p)).ok, p).toBe(false)
    expect(bad((r) => (r.files[0].path = 'a/.hidden/b.ts')).ok).toBe(true)
  })
  it('enforces action/skip/testFile cross-field rules', () => {
    expect(bad((r) => delete r.files[1].skip).ok).toBe(false)
    expect(bad((r) => delete r.files[0].testFile).ok).toBe(false)
    expect(bad((r) => (r.files[0].action = 'update')).ok).toBe(true)
    expect(bad((r) => delete r.files[0].testFile).ok).toBe(false)
    expect(
      bad((r) => (r.files[0].skip = { reason: 'excluded-from-coverage' })).ok,
    ).toBe(false)
    expect(
      bad((r) => {
        r.files[0].action = 'gave-up'
        delete r.files[0].testFile
      }).ok,
    ).toBe(true)
    expect(
      bad((r) => {
        r.files[0].action = 'gave-up'
        r.files[0].skip = { reason: 'excluded-from-coverage' }
      }).ok,
    ).toBe(false)
  })
  it('rejects a __proto__ key from JSON.parse', () => {
    const r = JSON.parse(
      JSON.stringify(valid()).replace(/^\{/, '{"__proto__":{"x":1},'),
    )
    expect(validateReport(r).ok).toBe(false)
  })
  it('rejects ambiguous skip and bad citations', () => {
    expect(bad((r) => (r.files[1].skip = { reason: 'other' })).ok).toBe(false)
    expect(
      bad(
        (r) =>
          (r.files[1].skip = {
            file: 'a',
            testName: 'b',
            reason: 'excluded-from-coverage',
          }),
      ).ok,
    ).toBe(false)
    expect(bad((r) => (r.defects[0].citation = { kind: 'openapi' })).ok).toBe(
      false,
    )
  })
  it('enforces caps', () => {
    expect(bad((r) => (r.narrative = 'x'.repeat(4001))).ok).toBe(false)
    expect(bad((r) => (r.narrative = 'x'.repeat(4000))).ok).toBe(true)
    expect(bad((r) => (r.behaviours[0].description = 'x'.repeat(501))).ok).toBe(
      false,
    )
    expect(
      bad((r) => (r.defects[1].citation.quote = 'x'.repeat(1001))).ok,
    ).toBe(false)
    expect(bad((r) => (r.defects = Array(21).fill(r.defects[0]))).ok).toBe(
      false,
    )
    expect(bad((r) => (r.files = Array(201).fill(r.files[0]))).ok).toBe(false)
    expect(
      bad((r) => (r.behaviours = Array(501).fill(r.behaviours[0]))).ok,
    ).toBe(false)
  })
  it('returns error strings', () => {
    const r = bad((r) => delete r.narrative)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatch(/narrative/)
  })
})
