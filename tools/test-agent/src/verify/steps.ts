import path from 'node:path'
import type { CoverageMap } from '../coverage.ts'
import { appOf, type Policy } from '../policy.ts'
import { parseRunnerArgs, vitestCommand } from '../runner.ts'
import type { App } from '../types.ts'
import type { RunSummary } from '../vitest-results.ts'
import { readRun, type ParsedRun } from './results.ts'
import { runStep, type SandboxEnv, type StepRun } from './sandbox.ts'

export const APPS: readonly App[] = ['backend', 'frontend']
/** Vitest JSON is written to `/results/run.json` (and `run-coverage/`) in every step. */
export const OUT = 'run'
const TYPECHECK = ['npx', 'tsc', '--noEmit', '-p', 'tsconfig.json']

export type Log = (line: string) => void

export type Suite =
  | { ok: true; summary: RunSummary; coverage: CoverageMap | null }
  | { ok: false; error: string }

/**
 * A suite step counts only when its exit code agrees with its parsed report: 0 with no failed
 * test, or 1 (Vitest's failure exit) with at least one. Anything else (timeout, crash, missing or
 * unreadable report, a failure the report does not show) is an unusable step.
 */
export function suiteOf(run: StepRun, parsed: ParsedRun): Suite {
  const { code, timedOut } = run.result
  if (timedOut) return { ok: false, error: 'timed out' }
  if (!parsed.ok) return { ok: false, error: `${parsed.error} (exit ${code})` }
  const failed = parsed.summary.failed > 0
  if ((code === 0 && !failed) || (code === 1 && failed)) return parsed
  return {
    ok: false,
    error: `exit ${code} disagrees with ${parsed.summary.failed} failed tests in the report`,
  }
}

/** A clean pass: exit 0 and a readable report without failures. */
export const passed = (s: Suite): s is Extract<Suite, { ok: true }> =>
  s.ok && s.summary.failed === 0

/**
 * tsc exits 1 or 2 on type errors, and then prints `TS<code>` diagnostics. Exit 1/2 without one
 * (npx failing, a crash) and any other non-zero exit are broken steps, not results.
 */
export function typecheckOf(run: StepRun): boolean | { error: string } {
  const { code, timedOut, stdout, stderr } = run.result
  if (timedOut) return { error: 'timed out' }
  if (code === 0) return true
  if (code !== 1 && code !== 2) return { error: `exit ${code}` }
  if (/\bTS\d+\b/.test(`${stdout}\n${stderr}`)) return false
  return { error: `exit ${code} without a TS diagnostic` }
}

const SHOWN_DIAGNOSTICS = 3

/** The first tsc diagnostics of a failed typecheck, one per line, for the PR comment. */
function firstDiagnostics(run: StepRun): string {
  const lines = `${run.result.stdout}\n${run.result.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\berror TS\d+:/.test(l))
  const shown = lines.slice(0, SHOWN_DIAGNOSTICS).map((l) => l.slice(0, 300))
  const more = lines.length - shown.length
  return shown.join('\n') + (more > 0 ? `\n(+${more} more)` : '')
}

/** The guard's runner argument rules (safe characters, no options, no traversal) for a repo path. */
export function runnable(
  policy: Policy,
  file: string,
): { app: App; rel: string } | null {
  const app = appOf(file)
  if (app === null) return null
  const rel = file.slice(app.length + 1)
  try {
    parseRunnerArgs([app, rel], policy)
    return { app, rel }
  } catch {
    return null
  }
}

export interface AppSuites {
  result: { typecheck: boolean; suite: RunSummary }
  coverage: CoverageMap | null
}

/** Typecheck and full suite with coverage for both apps, each in its own sandbox. Null (with notes) when any step is unusable. */
export async function runSuites(
  env: SandboxEnv,
  phase: 'baseline' | 'after',
  workDir: string,
  notes: string[],
  log: Log,
): Promise<Record<App, AppSuites> | null> {
  const out: Partial<Record<App, AppSuites>> = {}
  for (const app of APPS) {
    const source = path.join(workDir, app)
    log(`${phase} ${app} typecheck`)
    const tcRun = await runStep(env, `${phase}-${app}-typecheck`, app, source, {
      command: TYPECHECK,
    })
    const tc = typecheckOf(tcRun)
    if (tc === false)
      notes.push(`${phase} ${app} typecheck errors: ${firstDiagnostics(tcRun)}`)
    log(`${phase} ${app} suite`)
    const run = await runStep(env, `${phase}-${app}-suite`, app, source, {
      command: vitestCommand({ coverage: true, outputName: OUT }),
    })
    const suite = suiteOf(
      run,
      await readRun(env.fs, run.resultsDir, OUT, app, true),
    )
    if (typeof tc !== 'boolean')
      notes.push(`${phase} ${app} typecheck unusable: ${tc.error}`)
    if (!suite.ok) notes.push(`${phase} ${app} suite unusable: ${suite.error}`)
    if (typeof tc === 'boolean' && suite.ok)
      out[app] = {
        result: { typecheck: tc, suite: suite.summary },
        coverage: suite.coverage,
      }
  }
  return out.backend && out.frontend
    ? { backend: out.backend, frontend: out.frontend }
    : null
}
