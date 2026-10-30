import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  appLineCoverage,
  buildBackfillManifest,
  buildBackfillPlan,
  changedLineCoverage,
  executableLines,
  normalizeCoverage,
  uncoveredLines,
  type CoverageMap,
} from '../src/coverage.ts'
import { loadPolicy } from '../src/policy.ts'
import type { ManifestEntry } from '../src/types.ts'

const policy = loadPolicy()
const real = JSON.parse(
  readFileSync(
    new URL('fixtures/coverage-final.json', import.meta.url),
    'utf8',
  ),
) as CoverageMap

/** Builds an entry whose statements start on `lines`; `covered` lists the lines with count > 0. */
function entry(path: string, lines: number[], covered: number[]) {
  return {
    path,
    statementMap: Object.fromEntries(
      lines.map((l, i) => [
        String(i),
        { start: { line: l }, end: { line: l } },
      ]),
    ),
    s: Object.fromEntries(
      lines.map((l, i) => [String(i), covered.includes(l) ? 1 : 0]),
    ),
  }
}

function manifestEntry(over: Partial<ManifestEntry>): ManifestEntry {
  return {
    path: 'backend/src/a.ts',
    app: 'backend',
    status: 'modified',
    changedLines: [],
    excludedOnBase: false,
    ...over,
  }
}

describe('normalizeCoverage', () => {
  it('maps container paths to repo-relative POSIX paths (real fixture)', () => {
    const cov = normalizeCoverage(real, '/app', 'backend')
    expect(Object.keys(cov).sort()).toEqual([
      'backend/src/math.ts',
      'backend/src/unused.ts',
    ])
    expect(cov['backend/src/math.ts']?.path).toBe('backend/src/math.ts')
  })

  it('throws on a key outside the app root instead of dropping it', () => {
    expect(() =>
      normalizeCoverage(
        { '/elsewhere/x.ts': entry('/elsewhere/x.ts', [1], [1]) },
        '/app',
        'frontend',
      ),
    ).toThrow(/outside/)
    expect(() =>
      normalizeCoverage(
        { '/application/x.ts': entry('/application/x.ts', [1], [1]) },
        '/app',
        'backend',
      ),
    ).toThrow(/outside/)
  })

  it('rejects dot, empty and backslash segments', () => {
    for (const key of [
      '/app/a/./b.ts',
      '/app//b.ts',
      '/app/a/../b.ts',
      '/app/a\\b.ts',
    ])
      expect(() =>
        normalizeCoverage({ [key]: entry(key, [1], [1]) }, '/app', 'backend'),
      ).toThrow(/outside/)
  })
})

describe('executableLines', () => {
  it('marks a line covered when any statement starting on it has count > 0', () => {
    const e = {
      path: 'p',
      statementMap: {
        '0': { start: { line: 5 }, end: { line: 5 } },
        '1': { start: { line: 5 }, end: { line: 5 } },
        '2': { start: { line: 6 }, end: { line: 9 } },
      },
      s: { '0': 0, '1': 2, '2': 0 },
    }
    expect([...executableLines(e)]).toEqual([
      [5, true],
      [6, false],
    ])
  })

  it('reads the real fixture', () => {
    const cov = normalizeCoverage(real, '/app', 'backend')
    const lines = executableLines(cov['backend/src/math.ts']!)
    expect([...lines].sort((a, b) => a[0] - b[0])).toEqual([
      [2, true],
      [6, true],
      [7, true],
      [9, false],
      [10, false],
      [12, false],
    ])
  })
})

describe('changedLineCoverage', () => {
  const cov: CoverageMap = {
    'backend/src/a.ts': entry('backend/src/a.ts', [3, 4, 10], [3]),
  }

  it('counts only executable changed lines', () => {
    expect(
      changedLineCoverage(cov, manifestEntry({ changedLines: [3, 4, 99] })),
    ).toEqual({ status: 'measured', covered: 1, total: 2, pct: 0.5 })
  })

  it('is excluded when excluded on base', () => {
    expect(
      changedLineCoverage(
        cov,
        manifestEntry({ changedLines: [3], excludedOnBase: true }),
      ),
    ).toEqual({ status: 'excluded', covered: 0, total: 0, pct: null })
  })

  it('is missing with pct 0 when the file is absent', () => {
    expect(
      changedLineCoverage(
        cov,
        manifestEntry({ path: 'backend/src/b.ts', changedLines: [1, 2] }),
      ),
    ).toEqual({ status: 'missing', covered: 0, total: 0, pct: 0 })
  })

  it('has a null pct when no changed line is executable', () => {
    expect(
      changedLineCoverage(cov, manifestEntry({ changedLines: [99] })),
    ).toEqual({ status: 'measured', covered: 0, total: 0, pct: null })
  })
})

describe('uncoveredLines', () => {
  it('returns sorted uncovered lines; empty for an unknown file', () => {
    const cov = normalizeCoverage(real, '/app', 'backend')
    expect(uncoveredLines(cov, 'backend/src/math.ts')).toEqual([9, 10, 12])
    expect(uncoveredLines(cov, 'backend/src/none.ts')).toEqual([])
  })
})

describe('appLineCoverage', () => {
  it('matches the hand-computed fixture (3 of 9 lines)', () => {
    const cov = normalizeCoverage(real, '/app', 'backend')
    // math.ts: 6 lines, 3 covered; unused.ts: 3 lines, 0 covered
    const r = appLineCoverage(cov)
    expect(r.covered).toBe(3)
    expect(r.total).toBe(9)
    expect(r.pct).toBeCloseTo(1 / 3)
  })

  it('is 0 for an empty map', () => {
    expect(appLineCoverage({})).toEqual({ covered: 0, total: 0, pct: 0 })
  })
})

describe('buildBackfillManifest', () => {
  const cov: CoverageMap = {
    'backend/src/big.ts': entry('backend/src/big.ts', [1, 2, 3, 4, 5], [1]), // 4 uncovered
    'backend/src/mid.ts': entry('backend/src/mid.ts', [1, 2, 3], [1]), // 2
    'backend/src/mid2.ts': entry('backend/src/mid2.ts', [1, 2, 3], [1]), // 2
    'backend/src/full.ts': entry('backend/src/full.ts', [1, 2], [1, 2]), // 0
    'backend/src/types.ts': entry(
      'backend/src/types.ts',
      [1, 2, 3, 4, 5, 6],
      [],
    ),
    'backend/src/x.test.ts': entry(
      'backend/src/x.test.ts',
      [1, 2, 3, 4, 5, 6, 7],
      [],
    ),
    'frontend/src/f.ts': entry(
      'frontend/src/f.ts',
      [1, 2, 3, 4, 5, 6, 7, 8],
      [],
    ),
    'backend/prisma/seed.ts': entry(
      'backend/prisma/seed.ts',
      [1, 2, 3, 4, 5, 6, 7, 8],
      [],
    ),
  }

  it('returns the files with the most uncovered lines and never an excluded or foreign file', () => {
    const m = buildBackfillManifest(cov, 'backend', policy, 2, [
      'src/**/types.ts',
    ])
    expect(m.map((e) => e.path)).toEqual([
      'backend/src/big.ts',
      'backend/src/mid.ts',
    ])
    expect(m[0]).toEqual({
      path: 'backend/src/big.ts',
      app: 'backend',
      status: 'modified',
      changedLines: [2, 3, 4, 5],
      excludedOnBase: false,
    })
  })

  it('breaks ties by path and skips fully covered files', () => {
    const m = buildBackfillManifest(cov, 'backend', policy, 10, [
      'src/**/types.ts',
    ])
    expect(m.map((e) => e.path)).toEqual([
      'backend/src/big.ts',
      'backend/src/mid.ts',
      'backend/src/mid2.ts',
    ])
  })

  it('applies excludes relative to the app root', () => {
    const m = buildBackfillManifest(cov, 'backend', policy, 10, ['src/big.ts'])
    expect(m.map((e) => e.path)).not.toContain('backend/src/big.ts')
  })
})

describe('buildBackfillPlan', () => {
  const cov: CoverageMap = {
    'backend/src/a.ts': entry('backend/src/a.ts', [1, 2], [1]),
  }
  const base = {
    cov,
    app: 'backend' as const,
    policy,
    maxFiles: 8,
    excludes: [],
    baseSha: 'abc',
  }

  it('builds a backfill plan with no PR', () => {
    const plan = buildBackfillPlan(base)
    expect(plan).toMatchObject({
      mode: 'backfill',
      prNumber: null,
      baseSha: 'abc',
      headSha: 'abc',
      title: '',
      description: '',
      draft: false,
      earlyOutcome: null,
      budgetProfile: 'backfill',
    })
    expect(plan.manifest.map((m) => m.path)).toEqual(['backend/src/a.ts'])
  })

  it('has nothing to test when everything is covered', () => {
    const plan = buildBackfillPlan({ ...base, cov: {} })
    expect(plan.earlyOutcome).toBe('nothing-to-test')
  })
})
