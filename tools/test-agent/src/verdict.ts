import type { CoverageResult } from './coverage.ts'
import type { Violation } from './gates.ts'
import { isEvidencePath, type Policy } from './policy.ts'
import type { Report } from './report.ts'
import type {
  App,
  Conclusion,
  ManifestEntry,
  Mode,
  Outcome,
  Plan,
} from './types.ts'
import {
  discoveryMismatch,
  type RunSummary,
  type TestStatus,
} from './vitest-results.ts'

/** Display numbers for the comment's verification table. Never used to decide the outcome. */
export interface AppNumbers {
  typecheckBefore: boolean
  typecheckAfter: boolean | null
  suiteBefore: { passed: number; total: number }
  suiteAfter: { passed: number; total: number } | null
  stability: { passedRuns: number; runs: number } | null
  /** `pct: null` means unknown and is passed through as such. */
  changedLines: {
    file: string
    before: CoverageResult
    after: CoverageResult | null
  }[]
  /** Backfill only. */
  appLines: { before: number; after: number | null } | null
}

export type AgentStop =
  'success' | 'max-turns' | 'max-budget' | 'error' | 'unknown' | 'timeout'

export interface VerdictInputs {
  plan: Plan
  /** Trusted policy (loaded from the package, never from the work dir). */
  policy: Policy
  /** null only when the agent did not run (plan early outcome). */
  agentStop: AgentStop | null
  report: { ok: true; report: Report } | { ok: false; errors: string[] } | null
  gates: { ok: boolean; violations: Violation[] } | null
  /** R6: the real changed-file set after `git apply`; `ok: false` when it strays outside the gated set. */
  appliedPaths: { ok: boolean; offending: string[] } | null
  unguardedToolUses: string[]
  baseline: Record<App, { typecheck: boolean; suite: RunSummary }> | null
  after: Record<
    App,
    { typecheck: boolean; suite: RunSummary; expectedFiles: string[] }
  > | null
  /** Test files the patch adds or modifies (from the patch, never the report; evidence excluded). Each needs a stability entry; R9 compares passing counts for `modified` ones. */
  patchTestFiles: { path: string; status: 'added' | 'modified' }[]
  /** One entry per patch test file; `tests` holds every test result of all its runs. */
  stability: {
    file: string
    passedRuns: number
    tests: { name: string; status: TestStatus }[]
  }[]
  /** One per cited skip: keyed by the manifest (source) path plus the cited test file and name. */
  skipChecks: {
    path: string
    file: string
    testName: string
    ok: boolean
    detail: string
  }[]
  evidence: {
    file: string
    failuresOnHead: number
    allAssertion: boolean
    citationOk: boolean
  }[]
  numbers: Record<App, AppNumbers>
  patchSha256: string | null
  /** True when the patch without evidence files changes nothing. */
  patchEmpty: boolean
}

export interface Verdict {
  mode: Mode
  outcome: Outcome
  conclusion: Conclusion
  commitAllowed: boolean
  patchSha256: string | null
  reasons: string[]
  files: { path: string; action: string; details: string }[]
  defects: {
    file: string
    evidenceTest: string
    citation: string
    accepted: boolean
    rejectReason?: string
  }[]
  numbers: Record<App, AppNumbers>
  banners: {
    dependenciesChanged: boolean
    testsRemovedByAuthor: { file: string; count: number }[]
    configChanged: boolean
  }
  /** Per app with a failing baseline: failing test names, and `typecheck: true` when the typecheck failed. */
  baselineFailures: { app: App; tests: string[]; typecheck: boolean }[]
}

const APPS: readonly App[] = ['backend', 'frontend']
const STABILITY_RUNS = 3
const EVIDENCE_RUNS = 3

const CONCLUSIONS: Record<Outcome, Conclusion> = {
  'tests-added': 'success',
  'already-covered': 'success',
  'nothing-to-test': 'success',
  draft: 'neutral',
  'config-changed': 'neutral',
  'budget-exhausted': 'neutral',
  timeout: 'neutral',
  'patch-rejected': 'neutral',
  'verification-failed': 'neutral',
  'skip-unverified': 'neutral',
  'discovery-mismatch': 'neutral',
  'agent-run-invalid': 'neutral',
  'baseline-failing': 'neutral',
  'head-moved': 'neutral',
  'pipeline-error': 'neutral',
  defect: 'failure',
  'defect-dismissed': 'neutral',
}

/** Spec §9.1. In backfill mode a defect does not affect the conclusion. */
export function conclusionFor(
  outcome: Outcome,
  mode: Mode,
): Conclusion | 'unaffected' {
  if (outcome === 'defect' && mode === 'backfill') return 'unaffected'
  return CONCLUSIONS[outcome]
}

type ReportFile = Report['files'][number]
type ReportDefect = Report['defects'][number]
type Stage = { outcome: Outcome; reasons: string[] }

const testId = (file: string, name: string) => `${file} > ${name}`
const isClean = (s: TestStatus) => s === 'passed' || s === 'failed'

function citationText(c: ReportDefect['citation']): string {
  return c.kind === 'openapi'
    ? `openapi.json ${c.pointer}`
    : `PR description: "${c.quote}"`
}

/** Stages before the patch is verified; a hit means nothing later (including evidence) is trusted. */
function preVerification(i: VerdictInputs): Stage | null {
  const stop = i.agentStop
  if (stop === 'max-turns' || stop === 'max-budget')
    return {
      outcome: 'budget-exhausted',
      reasons: [`agent stopped: ${stop}`],
    }
  if (stop === 'timeout')
    return { outcome: 'timeout', reasons: ['agent run timed out'] }
  if (stop !== 'success')
    return {
      outcome: 'pipeline-error',
      reasons: [`agent did not finish successfully (stop: ${stop ?? 'none'})`],
    }
  if (i.unguardedToolUses.length > 0)
    return {
      outcome: 'agent-run-invalid',
      reasons: [
        `tool uses without a guard record: ${i.unguardedToolUses.join(', ')}`,
      ],
    }
  if (i.report === null)
    return { outcome: 'pipeline-error', reasons: ['report missing'] }
  if (!i.report.ok)
    return {
      outcome: 'pipeline-error',
      reasons: i.report.errors.map((e) => `report invalid: ${e}`),
    }
  if (i.baseline === null)
    return { outcome: 'pipeline-error', reasons: ['baseline results missing'] }
  const baselineReasons: string[] = []
  for (const app of APPS) {
    const b = i.baseline[app]
    if (!b.typecheck)
      baselineReasons.push(`${app}: typecheck fails on head before the patch`)
    for (const f of b.suite.failures)
      baselineReasons.push(
        `${app}: ${testId(f.file, f.name)} fails on head before the patch`,
      )
    if (b.suite.failed > 0 && b.suite.failures.length === 0)
      baselineReasons.push(`${app}: suite fails on head before the patch`)
  }
  if (baselineReasons.length > 0)
    return { outcome: 'baseline-failing', reasons: baselineReasons }
  if (i.gates === null || i.appliedPaths === null)
    return {
      outcome: 'pipeline-error',
      reasons: [
        i.gates === null
          ? 'patch gate results missing'
          : 'applied paths missing',
      ],
    }
  const rejected = [
    ...i.gates.violations.map((v) => `${v.file}: ${v.rule} (${v.detail})`),
    ...i.appliedPaths.offending.map(
      (p) => `${p}: changed by git apply outside the gated set`,
    ),
  ]
  if (!i.gates.ok && i.gates.violations.length === 0)
    rejected.push('patch gates failed')
  if (!i.appliedPaths.ok && i.appliedPaths.offending.length === 0)
    rejected.push('applied paths check failed')
  if (rejected.length > 0)
    return { outcome: 'patch-rejected', reasons: rejected }
  if (i.after === null)
    return { outcome: 'pipeline-error', reasons: ['after results missing'] }
  // The evidence-stripped patch is non-empty exactly when it touches a test file (gates allow nothing else).
  if (!i.patchEmpty && i.patchTestFiles.length === 0)
    return {
      outcome: 'pipeline-error',
      reasons: [
        'inconsistent verify inputs: non-empty patch without patch test files',
      ],
    }
  if (i.patchEmpty && i.patchTestFiles.length > 0)
    return {
      outcome: 'pipeline-error',
      reasons: [
        'inconsistent verify inputs: empty patch with patch test files',
      ],
    }
  return null
}

function verificationProblems(
  i: VerdictInputs,
  report: Report,
  baseline: NonNullable<VerdictInputs['baseline']>,
  after: NonNullable<VerdictInputs['after']>,
): string[] {
  const out: string[] = []
  const modified = new Set(
    i.patchTestFiles.filter((f) => f.status === 'modified').map((f) => f.path),
  )
  const stabilityByFile = new Map(i.stability.map((s) => [s.file, s]))
  const basePassed: Record<string, number> = {}
  const afterPassed: Record<string, number> = {}

  for (const app of APPS) {
    const a = after[app]
    const b = baseline[app]
    Object.assign(basePassed, b.suite.passedByFile)
    Object.assign(afterPassed, a.suite.passedByFile)
    if (!a.typecheck) out.push(`${app}: typecheck fails after the patch`)
    for (const f of a.suite.failures)
      out.push(`${app}: ${testId(f.file, f.name)} fails after the patch`)
    if (a.suite.failed > 0 && a.suite.failures.length === 0)
      out.push(`${app}: suite fails after the patch`)
    if (a.suite.total < b.suite.total)
      out.push(
        `${app}: test count dropped from ${b.suite.total} to ${a.suite.total}`,
      )
    // R9: skipped/todo/pending tests are weakening, unless the same test had the same status
    // on head in a file the patch did not touch.
    const baseStatus = new Map(
      b.suite.tests.map((t) => [testId(t.file, t.name), t.status]),
    )
    for (const t of a.suite.tests) {
      if (isClean(t.status)) continue
      const id = testId(t.file, t.name)
      if (!modified.has(t.file) && baseStatus.get(id) === t.status) continue
      out.push(`${app}: ${id} is ${t.status} after the patch`)
    }
  }

  for (const f of i.patchTestFiles) {
    if (!stabilityByFile.has(f.path)) out.push(`${f.path}: no stability run`)
    if (f.status !== 'modified') continue
    const before = basePassed[f.path] ?? 0
    const now = afterPassed[f.path] ?? 0
    if (now < before)
      out.push(`${f.path}: passing tests dropped from ${before} to ${now}`)
  }

  for (const s of i.stability) {
    if (s.passedRuns !== STABILITY_RUNS)
      out.push(
        `${s.file}: passed ${s.passedRuns}/${STABILITY_RUNS} stability runs`,
      )
    if (!s.tests.some((t) => t.status === 'passed'))
      out.push(`${s.file}: no passed test in stability runs`)
    const flagged = new Set<string>()
    for (const t of s.tests) {
      if (isClean(t.status)) continue
      const msg = `${testId(s.file, t.name)} is ${t.status} in a stability run`
      if (!flagged.has(msg)) out.push(msg)
      flagged.add(msg)
    }
  }

  const manifestPaths = new Set(i.plan.manifest.map((m) => m.path))
  const decided = new Set(report.files.map((f) => f.path))
  for (const m of i.plan.manifest)
    if (!decided.has(m.path)) out.push(`no decision for ${m.path}`)
  for (const f of report.files) {
    if (!manifestPaths.has(f.path)) continue
    if (
      (f.action === 'create' || f.action === 'update') &&
      f.testFile !== undefined &&
      !stabilityByFile.has(f.testFile)
    )
      out.push(
        `report claims ${f.testFile} for ${f.path}, but the patch does not add or change it`,
      )
  }
  const gaveUp = report.files.filter(
    (f) => f.action === 'gave-up' && manifestPaths.has(f.path),
  )
  if (gaveUp.length > 0 && i.patchEmpty)
    out.push(
      `gave up on ${gaveUp.map((f) => f.path).join(', ')} and no test file was committed`,
    )
  return out
}

function checksFor(
  i: VerdictInputs,
  path: string,
  cited: { file: string; testName: string },
) {
  return i.skipChecks.filter(
    (c) =>
      c.path === path && c.file === cited.file && c.testName === cited.testName,
  )
}

function skipProblems(i: VerdictInputs, report: Report): string[] {
  const out: string[] = []
  const manifest = new Map(i.plan.manifest.map((m) => [m.path, m]))
  for (const f of report.files) {
    const m = manifest.get(f.path)
    if (!m || f.action !== 'skip') continue
    if (!f.skip) {
      out.push(`skip of ${f.path} not verified: no skip target`)
      continue
    }
    if ('reason' in f.skip) {
      if (!m.excludedOnBase)
        out.push(
          `skip of ${f.path} claims excluded from coverage, but it is not excluded on base`,
        )
      continue
    }
    const cited = testId(f.skip.file, f.skip.testName)
    const checks = checksFor(i, f.path, f.skip)
    if (checks.length === 0)
      out.push(`skip of ${f.path} citing ${cited} not verified: no check ran`)
    for (const c of checks)
      if (!c.ok)
        out.push(`skip of ${f.path} citing ${cited} not verified: ${c.detail}`)
  }
  return out
}

function judgeDefect(
  d: ReportDefect,
  i: VerdictInputs,
): { accepted: true } | { accepted: false; rejectReason: string } {
  const reject = (rejectReason: string) =>
    ({ accepted: false, rejectReason }) as const
  if (!i.plan.manifest.some((m) => m.path === d.file))
    return reject('file is not in the manifest')
  if (!isEvidencePath(i.policy, d.evidenceTest))
    return reject('evidence test is not under an __evidence__ directory')
  const runs = i.evidence.filter((e) => e.file === d.evidenceTest)
  if (runs.length === 0) return reject('evidence test was not run')
  if (runs.length > 1) return reject('ambiguous evidence results')
  const e = runs[0]!
  if (e.failuresOnHead !== EVIDENCE_RUNS)
    return reject(
      `evidence test failed on ${e.failuresOnHead}/${EVIDENCE_RUNS} head runs`,
    )
  if (!e.allAssertion) return reject('a failure was not an assertion failure')
  if (!e.citationOk) return reject('citation not found')
  return { accepted: true }
}

function fileRows(
  i: VerdictInputs,
  report: Report | null,
  defects: Verdict['defects'],
): Verdict['files'] {
  const rows: Verdict['files'] = []
  const passedIn = (file: string): number | null => {
    if (!i.after) return null
    let n = 0
    for (const app of APPS)
      for (const t of i.after[app].suite.tests)
        if (t.file === file && t.status === 'passed') n++
    return n
  }
  const row = (m: ManifestEntry, f: ReportFile) => {
    switch (f.action) {
      case 'create':
      case 'update': {
        const n = f.testFile ? passedIn(f.testFile) : null
        const details =
          f.testFile === undefined
            ? ''
            : n === null
              ? f.testFile
              : `${f.testFile}: ${n} tests`
        return { path: m.path, action: f.action, details }
      }
      case 'gave-up':
        return { path: m.path, action: 'gave up', details: '' }
      case 'skip': {
        if (!f.skip)
          return { path: m.path, action: 'skip', details: 'no skip target' }
        if ('reason' in f.skip)
          return m.excludedOnBase
            ? { path: m.path, action: 'excluded from coverage', details: '' }
            : {
                path: m.path,
                action: 'skip',
                details:
                  'claimed excluded from coverage (not excluded on base)',
              }
        const cited = testId(f.skip.file, f.skip.testName)
        const checks = checksFor(i, m.path, f.skip)
        const failed = checks.filter((c) => !c.ok)
        const checked = checks.length > 0
        const suffix =
          failed.length > 0
            ? ` (unverified: ${failed.map((c) => c.detail).join('; ')})`
            : checked
              ? ''
              : ' (unverified)'
        return { path: m.path, action: 'skip', details: cited + suffix }
      }
    }
  }
  for (const m of i.plan.manifest) {
    const entries = report?.files.filter((f) => f.path === m.path) ?? []
    if (entries.length === 0) {
      rows.push(
        report
          ? {
              path: m.path,
              action: 'no decision',
              details: `no decision for ${m.path}`,
            }
          : m.excludedOnBase
            ? { path: m.path, action: 'excluded from coverage', details: '' }
            : { path: m.path, action: 'no decision', details: '' },
      )
      continue
    }
    for (const f of entries) rows.push(row(m, f))
  }
  for (const d of defects)
    if (d.accepted)
      rows.push({
        path: d.file,
        action: 'suspected defect',
        details: d.citation,
      })
  return rows
}

function baselineFailures(i: VerdictInputs): Verdict['baselineFailures'] {
  if (!i.baseline) return []
  const out: Verdict['baselineFailures'] = []
  for (const app of APPS) {
    const b = i.baseline[app]
    const tests = b.suite.failures.map((f) => testId(f.file, f.name))
    if (!b.typecheck || tests.length > 0 || b.suite.failed > 0)
      out.push({ app, tests, typecheck: !b.typecheck })
  }
  return out
}

/** The single deterministic decision of outcome, conclusion and commit permission (spec §9.1). Pure. */
export function computeVerdict(i: VerdictInputs): Verdict {
  const { plan } = i
  const report = i.report?.ok ? i.report.report : null
  const reasons: string[] = []
  let stage: Stage
  let verified = false

  if (plan.earlyOutcome !== null) {
    stage = {
      outcome: plan.earlyOutcome,
      reasons: [`plan: ${plan.earlyOutcome}`],
    }
  } else {
    const pre = preVerification(i)
    if (pre) stage = pre
    else {
      // preVerification guarantees report, baseline and after are present.
      verified = true
      const after = i.after!
      const missing = APPS.flatMap((app) =>
        discoveryMismatch(after[app].expectedFiles, after[app].suite.files).map(
          (f) => `${app}: ${f} was expected but did not run`,
        ),
      )
      const vf = verificationProblems(i, report!, i.baseline!, after)
      const skips = skipProblems(i, report!)
      stage =
        missing.length > 0
          ? { outcome: 'discovery-mismatch', reasons: missing }
          : vf.length > 0
            ? { outcome: 'verification-failed', reasons: vf }
            : skips.length > 0
              ? { outcome: 'skip-unverified', reasons: skips }
              : {
                  outcome: i.patchEmpty ? 'already-covered' : 'tests-added',
                  reasons: [],
                }
    }
  }
  reasons.push(...stage.reasons)

  if (report) {
    const manifestPaths = new Set(plan.manifest.map((m) => m.path))
    for (const f of report.files)
      if (!manifestPaths.has(f.path))
        reasons.push(`ignored report entry for ${f.path} (not in manifest)`)
  }

  const defects: Verdict['defects'] = (report?.defects ?? []).map((d) => {
    const base = {
      file: d.file,
      evidenceTest: d.evidenceTest,
      citation: citationText(d.citation),
    }
    if (!verified)
      return {
        ...base,
        accepted: false,
        rejectReason: `not evaluated: run ended with ${stage.outcome}`,
      }
    return { ...base, ...judgeDefect(d, i) }
  })
  for (const d of defects)
    reasons.push(
      d.accepted
        ? `suspected defect in ${d.file} (evidence ${d.evidenceTest})`
        : `defect claim for ${d.file} rejected: ${d.rejectReason}`,
    )

  const baseOutcome = stage.outcome
  const outcome: Outcome =
    plan.mode === 'pr' && verified && defects.some((d) => d.accepted)
      ? 'defect'
      : baseOutcome
  const conclusion = conclusionFor(outcome, plan.mode)
  if (conclusion === 'unaffected')
    throw new Error('unreachable: defect outcome in backfill mode')
  const commitAllowed =
    !i.patchEmpty &&
    baseOutcome === 'tests-added' &&
    (outcome === 'tests-added' || outcome === 'defect')

  return {
    mode: plan.mode,
    outcome,
    conclusion,
    commitAllowed,
    patchSha256: i.patchSha256,
    reasons,
    files: fileRows(i, report, defects),
    defects,
    numbers: i.numbers,
    banners: {
      dependenciesChanged: plan.dependenciesChanged,
      testsRemovedByAuthor: plan.testsRemovedByAuthor.map((t) => ({ ...t })),
      configChanged: plan.earlyOutcome === 'config-changed',
    },
    baselineFailures: baselineFailures(i),
  }
}
