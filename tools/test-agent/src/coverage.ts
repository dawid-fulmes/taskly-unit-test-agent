import { excludedOnBase } from './plan.ts'
import { isSourcePath, type Policy } from './policy.ts'
import type { App, ManifestEntry, Plan } from './types.ts'

export type CoverageEntry = {
  path: string
  statementMap: Record<
    string,
    { start: { line: number }; end: { line: number } }
  >
  s: Record<string, number>
}
/** Istanbul `coverage-final.json` (as written by @vitest/coverage-v8 with `--coverage.reporter=json`). */
export type CoverageMap = Record<string, CoverageEntry>

export type CoverageResult = {
  status: 'measured' | 'missing' | 'excluded'
  covered: number
  total: number
  /** Fraction 0..1 (same scale as policy.skipMinChangedLineCoverage); null when nothing is measurable. */
  pct: number | null
}

/** Rewrites container paths (`/app/src/x.ts`) to repo-relative POSIX (`backend/src/x.ts`). Files outside the app root are dropped. */
export function normalizeCoverage(
  cov: CoverageMap,
  appRootInContainer: string,
  app: App,
): CoverageMap {
  const root = appRootInContainer.replace(/\/+$/, '')
  const out: CoverageMap = {}
  for (const [key, entry] of Object.entries(cov)) {
    if (!key.startsWith(`${root}/`)) continue
    const rest = key.slice(root.length + 1)
    if (rest.split('/').includes('..')) continue
    const path = `${app}/${rest}`
    out[path] = { ...entry, path }
  }
  return out
}

/** Line to covered flag. A line is covered if any statement starting on it has a count above zero. */
export function executableLines(entry: CoverageEntry): Map<number, boolean> {
  const lines = new Map<number, boolean>()
  for (const [id, stmt] of Object.entries(entry.statementMap)) {
    const line = stmt.start.line
    const hit = (entry.s[id] ?? 0) > 0
    lines.set(line, (lines.get(line) ?? false) || hit)
  }
  return lines
}

export function changedLineCoverage(
  cov: CoverageMap,
  e: ManifestEntry,
): CoverageResult {
  if (e.excludedOnBase)
    return { status: 'excluded', covered: 0, total: 0, pct: null }
  const entry = cov[e.path]
  if (entry === undefined)
    return { status: 'missing', covered: 0, total: 0, pct: 0 }
  const lines = executableLines(entry)
  let covered = 0
  let total = 0
  for (const line of new Set(e.changedLines)) {
    const hit = lines.get(line)
    if (hit === undefined) continue
    total++
    if (hit) covered++
  }
  return {
    status: 'measured',
    covered,
    total,
    pct: total === 0 ? null : covered / total,
  }
}

export function uncoveredLines(cov: CoverageMap, file: string): number[] {
  const entry = cov[file]
  if (entry === undefined) return []
  return [...executableLines(entry)]
    .filter(([, hit]) => !hit)
    .map(([line]) => line)
    .sort((a, b) => a - b)
}

/**
 * Source files of `app` that still have uncovered lines, most uncovered first (ties by path).
 * Fully covered files are skipped: there is nothing to backfill.
 */
export function buildBackfillManifest(
  cov: CoverageMap,
  app: App,
  policy: Policy,
  maxFiles: number,
  excludes: string[],
): ManifestEntry[] {
  return Object.keys(cov)
    .filter(
      (path) =>
        path.startsWith(`${app}/`) &&
        isSourcePath(policy, path) &&
        !excludedOnBase(path, app, excludes),
    )
    .map((path) => ({ path, lines: uncoveredLines(cov, path) }))
    .filter((f) => f.lines.length > 0)
    .sort(
      (a, b) => b.lines.length - a.lines.length || (a.path < b.path ? -1 : 1),
    )
    .slice(0, Math.max(0, maxFiles))
    .map((f): ManifestEntry => ({
      path: f.path,
      app,
      status: 'modified',
      changedLines: f.lines,
      excludedOnBase: false,
    }))
}

export function appLineCoverage(cov: CoverageMap): {
  covered: number
  total: number
  pct: number
} {
  let covered = 0
  let total = 0
  for (const entry of Object.values(cov))
    for (const hit of executableLines(entry).values()) {
      total++
      if (hit) covered++
    }
  return { covered, total, pct: total === 0 ? 0 : covered / total }
}

/** Backfill plan: base and head are both the analysed base commit; there is no PR. */
export function buildBackfillPlan(input: {
  cov: CoverageMap
  app: App
  policy: Policy
  maxFiles: number
  excludes: string[]
  baseSha: string
}): Plan {
  const manifest = buildBackfillManifest(
    input.cov,
    input.app,
    input.policy,
    input.maxFiles,
    input.excludes,
  )
  return {
    mode: 'backfill',
    prNumber: null,
    baseSha: input.baseSha,
    headSha: input.baseSha,
    title: '',
    description: '',
    draft: false,
    earlyOutcome: manifest.length === 0 ? 'nothing-to-test' : null,
    manifest,
    dependenciesChanged: false,
    testsRemovedByAuthor: [],
    budgetProfile: 'backfill',
  }
}
