import {
  appLineCoverage,
  changedLineCoverage,
  type CoverageMap,
} from '../coverage.ts'
import { appOf } from '../policy.ts'
import type { App } from '../types.ts'
import type { AppNumbers, VerdictInputs } from '../verdict.ts'
import { STABILITY } from './checks.ts'
import { APPS } from './steps.ts'

export function emptyNumbers(): AppNumbers {
  return {
    typecheckBefore: false,
    typecheckAfter: null,
    suiteBefore: { passed: 0, total: 0 },
    suiteAfter: null,
    stability: null,
    changedLines: [],
    appLines: null,
  }
}

/** Display numbers for the comment, from whatever the run produced. */
export function buildNumbers(
  inp: VerdictInputs,
  baseCov: Partial<Record<App, CoverageMap>>,
  afterCov: Partial<Record<App, CoverageMap>>,
): Record<App, AppNumbers> {
  const out = { backend: emptyNumbers(), frontend: emptyNumbers() }
  for (const app of APPS) {
    const n = out[app]
    const base = inp.baseline?.[app]
    const aft = inp.after?.[app]
    if (base) {
      n.typecheckBefore = base.typecheck
      n.suiteBefore = { passed: base.suite.passed, total: base.suite.total }
    }
    if (aft) {
      n.typecheckAfter = aft.typecheck
      n.suiteAfter = { passed: aft.suite.passed, total: aft.suite.total }
    }
    const stab = inp.stability.filter((s) => appOf(s.file) === app)
    if (stab.length > 0)
      n.stability = {
        passedRuns: stab.reduce((sum, s) => sum + s.passedRuns, 0),
        runs: stab.length * STABILITY.length,
      }
    const manifest = inp.plan.manifest.filter((m) => m.app === app)
    const bc = baseCov[app]
    const ac = afterCov[app]
    if (bc)
      n.changedLines = manifest.map((m) => ({
        file: m.path,
        before: changedLineCoverage(bc, m),
        after: ac ? changedLineCoverage(ac, m) : null,
      }))
    if (inp.plan.mode === 'backfill' && manifest.length > 0 && bc)
      n.appLines = {
        before: appLineCoverage(bc).pct,
        after: ac ? appLineCoverage(ac).pct : null,
      }
  }
  return out
}
