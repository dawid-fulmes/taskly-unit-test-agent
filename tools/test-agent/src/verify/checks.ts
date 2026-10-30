import path from 'node:path'
import { quoteInDescription, resolvePointer } from '../citations.ts'
import { changedLineCoverage } from '../coverage.ts'
import type { FileDiff } from '../diff.ts'
import { checkApplied, type Violation } from '../gates.ts'
import { isTestPath, type Policy } from '../policy.ts'
import type { Report } from '../report.ts'
import { vitestCommand } from '../runner.ts'
import type { App, Plan } from '../types.ts'
import type { VerdictInputs } from '../verdict.ts'
import { sectionsFor } from './files.ts'
import { gitApply } from './git.ts'
import { readRun } from './results.ts'
import {
  createSandbox,
  runInSandbox,
  runStep,
  type Sandbox,
  type SandboxEnv,
} from './sandbox.ts'
import { OUT, passed, runnable, suiteOf, type Log } from './steps.ts'

// ADR 0005: three shuffled runs with distinct seeds and time zones.
export const STABILITY = [
  { seed: 1, tz: 'UTC' },
  { seed: 2, tz: 'America/Los_Angeles' },
  { seed: 3, tz: 'Asia/Kolkata' },
] as const
const EVIDENCE_RUNS = 3

const percent = (n: number) => `${Math.round(n * 1000) / 10}%`

/** Step 6: the file alone, three times, on the patched work tree. */
export async function stability(
  env: SandboxEnv,
  policy: Policy,
  workDir: string,
  index: number,
  file: string,
  log: Log,
): Promise<VerdictInputs['stability'][number]> {
  const entry: VerdictInputs['stability'][number] = {
    file,
    passedRuns: 0,
    tests: [],
  }
  const target = runnable(policy, file)
  // A path the runner rules refuse cannot be run: 0/3, judged by the verdict.
  if (target === null) return entry
  for (const { seed, tz } of STABILITY) {
    log(`stability ${file} seed ${seed}`)
    const run = await runStep(
      env,
      `stability-${index + 1}-seed-${seed}`,
      target.app,
      path.join(workDir, target.app),
      {
        command: vitestCommand({
          files: [target.rel],
          shuffle: true,
          seed,
          outputName: OUT,
        }),
        env: { TZ: tz },
      },
    )
    const parsed = await readRun(env.fs, run.resultsDir, OUT, target.app, false)
    if (parsed.ok)
      for (const t of parsed.summary.tests)
        if (t.file === file)
          entry.tests.push({ name: t.name, status: t.status })
    const suite = suiteOf(run, parsed)
    if (passed(suite) && suite.summary.files.includes(file)) entry.passedRuns++
  }
  return entry
}

type Citation = { path: string; file: string; testName: string }

/** One per report skip that cites a test for a manifest file (verdict keys checks the same way). */
function citations(plan: Plan, report: Report): Citation[] {
  const manifest = new Set(plan.manifest.map((m) => m.path))
  const out: Citation[] = []
  for (const f of report.files)
    if (
      f.action === 'skip' &&
      manifest.has(f.path) &&
      f.skip &&
      'file' in f.skip
    )
      out.push({ path: f.path, file: f.skip.file, testName: f.skip.testName })
  return out
}

export interface SkipRun {
  app: App
  rel: string
  sandbox: Sandbox | null
  error: string | null
}

/** Head copies for each distinct cited test file; a citation the runner rules refuse never reaches docker. */
export async function prepareSkipChecks(
  env: SandboxEnv,
  policy: Policy,
  plan: Plan,
  report: Report,
  workDir: string,
): Promise<Map<string, SkipRun>> {
  const runs = new Map<string, SkipRun>()
  for (const c of citations(plan, report)) {
    if (runs.has(c.file)) continue
    const target = isTestPath(policy, c.file) ? runnable(policy, c.file) : null
    if (target === null) {
      runs.set(c.file, {
        app: 'backend',
        rel: '',
        sandbox: null,
        error: 'cited file is not a runnable test file',
      })
      continue
    }
    const st = await env.fs.lstat(path.join(workDir, c.file)).catch(() => null)
    if (!st?.isFile()) {
      runs.set(c.file, {
        ...target,
        sandbox: null,
        error: 'cited file does not exist on head',
      })
      continue
    }
    const sandbox = await createSandbox(
      env,
      `skip-${runs.size + 1}`,
      target.app,
      path.join(workDir, target.app),
    )
    runs.set(c.file, { ...target, sandbox, error: null })
  }
  return runs
}

/** §7.4 / R16: the cited file alone with coverage on head must pass, contain the test, and cover the changed lines. */
export async function runSkipChecks(
  env: SandboxEnv,
  policy: Policy,
  plan: Plan,
  report: Report,
  runs: Map<string, SkipRun>,
  log: Log,
): Promise<VerdictInputs['skipChecks']> {
  const results = new Map<string, Awaited<ReturnType<typeof execute>>>()
  const execute = async (r: SkipRun) => {
    log(`skip check ${r.app}/${r.rel}`)
    const run = await runInSandbox(env, r.sandbox!, {
      command: vitestCommand({
        files: [r.rel],
        coverage: true,
        outputName: OUT,
      }),
    })
    return suiteOf(run, await readRun(env.fs, run.resultsDir, OUT, r.app, true))
  }
  const out: VerdictInputs['skipChecks'] = []
  for (const c of citations(plan, report)) {
    const r = runs.get(c.file)!
    const check = (ok: boolean, detail: string) =>
      out.push({ ...c, ok, detail })
    if (r.error !== null) {
      check(false, r.error)
      continue
    }
    if (!results.has(c.file)) results.set(c.file, await execute(r))
    const suite = results.get(c.file)!
    if (!suite.ok) {
      check(false, `run failed: ${suite.error}`)
      continue
    }
    const t = suite.summary.tests.find(
      (x) => x.file === c.file && x.name === c.testName,
    )
    if (!t) {
      check(false, 'cited test not found in the run')
      continue
    }
    if (t.status !== 'passed') {
      check(false, `cited test is ${t.status}`)
      continue
    }
    if (!passed(suite)) {
      check(false, 'cited file has failing tests on head')
      continue
    }
    const entry = plan.manifest.find((m) => m.path === c.path)!
    const cov = changedLineCoverage(suite.coverage ?? {}, entry)
    const min = policy.skipMinChangedLineCoverage
    if (cov.pct === null) {
      check(
        false,
        cov.status === 'excluded'
          ? 'file is excluded from coverage'
          : 'no executable changed lines measured',
      )
      continue
    }
    const covers = `covers ${cov.covered}/${cov.total} changed lines (${percent(cov.pct)})`
    if (cov.pct < min) check(false, `${covers}, below ${percent(min)}`)
    else check(true, covers)
  }
  // Prepared copies of citations that were never run are removed with the sandbox root.
  return out
}

export interface EvidenceRun {
  file: string
  app: App
  rel: string
  sandboxes: Sandbox[]
  error: string | null
}

/**
 * Head copies plus only this evidence file (never the work copy). The applied evidence file
 * is gated as written (R12); violations go to `violations`.
 */
export async function prepareEvidence(
  env: SandboxEnv,
  policy: Policy,
  diffs: FileDiff[],
  patchText: string,
  workDir: string,
  violations: Violation[],
): Promise<EvidenceRun[]> {
  const out: EvidenceRun[] = []
  for (const [i, d] of diffs.entries()) {
    const file = d.newPath!
    const target = runnable(policy, file)
    if (target === null) {
      out.push({
        file,
        app: 'backend',
        rel: '',
        sandboxes: [],
        error: 'not a runnable test file',
      })
      continue
    }
    const diffFile = path.join(env.runDir, `evidence-${i + 1}.diff`)
    await env.fs.writeFile(diffFile, sectionsFor(patchText, file))
    const run: EvidenceRun = { file, ...target, sandboxes: [], error: null }
    out.push(run)
    for (let r = 1; r <= EVIDENCE_RUNS; r++) {
      const sb = await createSandbox(
        env,
        `evidence-${i + 1}-run-${r}`,
        target.app,
        path.join(workDir, target.app),
      )
      try {
        await gitApply(env.exec, sb.root, diffFile, { outsideRepo: true })
      } catch (error) {
        run.error = `does not apply on head: ${(error as Error).message}`
        break
      }
      run.sandboxes.push(sb)
    }
    if (run.error !== null || run.sandboxes.length === 0) continue
    const written = path.join(run.sandboxes[0]!.root, file)
    const st = await env.fs.lstat(written).catch(() => null)
    if (!st?.isFile()) {
      violations.push({
        file,
        rule: 'integrity',
        detail: 'not a regular file after git apply',
      })
      continue
    }
    violations.push(
      ...checkApplied(
        [
          {
            path: file,
            status: d.status === 'added' ? 'added' : 'modified',
            text: await env.fs.readFile(written, 'utf8'),
            added: d.added,
          },
        ],
        policy,
      ).violations,
    )
  }
  return out
}

function citationOk(
  d: Report['defects'][number],
  plan: Plan,
  openapi: unknown,
): boolean {
  return d.citation.kind === 'openapi'
    ? openapi !== undefined && resolvePointer(openapi, d.citation.pointer)
    : quoteInDescription(d.citation.quote, plan.description)
}

/** Step 7 / §7.5: each evidence file alone on head, three times; every run must fail by assertion. */
export async function runEvidence(
  env: SandboxEnv,
  runs: EvidenceRun[],
  report: Report,
  plan: Plan,
  openapiText: string | null,
  log: Log,
): Promise<VerdictInputs['evidence']> {
  let openapi: unknown = undefined
  try {
    if (openapiText !== null) openapi = JSON.parse(openapiText)
  } catch {
    openapi = undefined
  }
  const out: VerdictInputs['evidence'] = []
  for (const e of runs) {
    let failuresOnHead = 0
    let allAssertion = true
    for (const sb of e.sandboxes) {
      log(`evidence ${e.file} ${sb.name}`)
      const run = await runInSandbox(env, sb, {
        command: vitestCommand({ files: [e.rel], outputName: OUT }),
      })
      const suite = suiteOf(
        run,
        await readRun(env.fs, run.resultsDir, OUT, e.app, false),
      )
      // A counted failure: Vitest's failure exit with a readable report whose failures are all in this file.
      if (!suite.ok || suite.summary.failed === 0) continue
      const failures = suite.summary.failures
      if (!failures.every((f) => f.file === e.file)) continue
      failuresOnHead++
      if (!failures.every((f) => f.isAssertion)) allAssertion = false
    }
    const claims = report.defects.filter((d) => d.evidenceTest === e.file)
    out.push({
      file: e.file,
      failuresOnHead,
      allAssertion: allAssertion && failuresOnHead > 0,
      citationOk:
        claims.length > 0 && claims.every((d) => citationOk(d, plan, openapi)),
    })
  }
  return out
}
