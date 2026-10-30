import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import type { CoverageMap } from './coverage.ts'
import { parseUnifiedDiff, type FileDiff } from './diff.ts'
import type { exec as realExec } from './exec.ts'
import {
  checkApplied,
  checkPatch,
  stripEvidence,
  type AppliedFile,
  type Violation,
} from './gates.ts'
import {
  isEvidencePath,
  isTestPath,
  loadPolicy,
  type Policy,
} from './policy.ts'
import { validateReport } from './report.ts'
import { runContainer } from './runner.ts'
import { guardCoverage, summarizeTranscript } from './transcript.ts'
import type { App, Plan } from './types.ts'
import { computeVerdict, type Verdict, type VerdictInputs } from './verdict.ts'
import {
  prepareEvidence,
  prepareSkipChecks,
  runEvidence,
  runSkipChecks,
  stability,
} from './verify/checks.ts'
import { expectedFiles } from './verify/files.ts'
import {
  appliedPathsCheck,
  git,
  gitApply,
  statusSnapshot,
} from './verify/git.ts'
import { buildNumbers, emptyNumbers } from './verify/numbers.ts'
import { writeLog, type SandboxEnv } from './verify/sandbox.ts'
import { APPS, runSuites } from './verify/steps.ts'

export interface VerifyDeps {
  exec: typeof realExec
  fs: typeof import('node:fs/promises')
  image: string
  /** `${uid}:${gid}` for containers; defaults to the current process. Never root. */
  user?: string
  /** Per container run. */
  timeoutMs?: number
  log?: (line: string) => void
}

export interface VerifyArgs {
  trustedDir: string
  /** Git checkout of the analysed head with dependencies installed. Receives the patch. */
  workDir: string
  /** Scratch dir: sandboxes, raw results, applied patch files, verdict inputs. */
  runDir: string
  plan: Plan
  patchPath: string
  /** sha256 of the patch as reported by `generate` (bare hex or `sha256sum` format). */
  patchShaPath: string
  reportPath: string
  transcriptPath: string
  guardLogPath: string
  agentStop: VerdictInputs['agentStop']
}

const PRISMA_GENERATE = ['npx', 'prisma', 'generate']
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function readText(
  fs: VerifyDeps['fs'],
  file: string,
): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

function readReport(text: string | null): VerdictInputs['report'] {
  if (text === null) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['report.json is not valid JSON'] }
  }
  return validateReport(data)
}

function unguardedToolUses(
  transcript: string | null,
  guardLog: string | null,
): string[] {
  if (transcript === null) return ['(transcript missing)']
  const t = summarizeTranscript(transcript)
  const out = guardCoverage(t.toolUseIds, guardLog ?? '')
  // Unparseable lines could hide tool uses: fail closed.
  if (t.invalidLines > 0)
    out.unshift(`(${t.invalidLines} unparseable transcript lines)`)
  return out
}

function readExpectedSha(text: string | null): string | null {
  const token = text?.trim().split(/\s+/)[0] ?? ''
  return /^[0-9a-f]{64}$/.test(token) ? token : null
}

function containerUser(override: string | undefined): string {
  const user =
    override ??
    (process.getuid && process.getgid
      ? `${process.getuid()}:${process.getgid()}`
      : null)
  if (user === null) throw new Error('uid/gid unavailable')
  if (/^0(:|$)/.test(user)) throw new Error('containers must not run as root')
  return user
}

/** Spec §7.1 integrity and gates; violations empty means the patch may be applied. */
function patchViolations(
  patchBuf: Buffer,
  patchText: string,
  actualSha: string,
  expectedSha: string | null,
  diffs: FileDiff[],
  policy: Policy,
): Violation[] {
  const integrity = (detail: string): Violation[] => [
    { file: 'patch.diff', rule: 'integrity', detail },
  ]
  if (expectedSha === null)
    return integrity('expected sha256 missing or malformed')
  if (expectedSha !== actualSha)
    return integrity(
      `sha256 mismatch: generate reported ${expectedSha}, verify computed ${actualSha}`,
    )
  if (!Buffer.from(patchText, 'utf8').equals(patchBuf))
    return integrity('patch is not valid UTF-8')
  return checkPatch(diffs, policy).violations
}

/** R12 on the work tree: every patched test file as `git apply` wrote it. */
async function gateApplied(
  fs: VerifyDeps['fs'],
  workDir: string,
  testDiffs: FileDiff[],
  policy: Policy,
): Promise<Violation[]> {
  const files: AppliedFile[] = []
  const out: Violation[] = []
  for (const d of testDiffs) {
    const file = d.newPath!
    const full = path.join(workDir, file)
    const st = await fs.lstat(full).catch(() => null)
    if (!st?.isFile()) {
      out.push({
        file,
        rule: 'integrity',
        detail: 'not a regular file after git apply',
      })
      continue
    }
    files.push({
      path: file,
      status: d.status === 'added' ? 'added' : 'modified',
      text: await fs.readFile(full, 'utf8'),
      added: d.added,
    })
  }
  out.push(...checkApplied(files, policy).violations)
  return out
}

/**
 * The `verify` job (spec §7): independently re-checks the agent's patch in sandboxed containers
 * and computes the verdict outside them. Throws only on internal failures.
 */
export async function runVerify(
  args: VerifyArgs,
  deps: VerifyDeps,
): Promise<Verdict> {
  const { fs, exec } = deps
  const { plan, workDir, runDir } = args
  const log = deps.log ?? (() => {})
  // Trusted policy: from the trusted checkout, never from the work dir.
  const policy = loadPolicy(
    path.join(args.trustedDir, 'tools/test-agent/policy.json'),
  )
  const user = containerUser(deps.user)
  const env: SandboxEnv = {
    exec,
    fs,
    image: deps.image,
    user,
    runDir,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  await fs.mkdir(runDir, { recursive: true })

  const reportInput = readReport(await readText(fs, args.reportPath))
  const patchBuf = await fs.readFile(args.patchPath).catch(() => null)
  const notes: string[] = []
  const baseCov: Partial<Record<App, CoverageMap>> = {}
  const afterCov: Partial<Record<App, CoverageMap>> = {}

  const inp: VerdictInputs = {
    plan,
    policy,
    agentStop: args.agentStop,
    report: reportInput,
    gates: null,
    appliedPaths: null,
    unguardedToolUses: unguardedToolUses(
      await readText(fs, args.transcriptPath),
      await readText(fs, args.guardLogPath),
    ),
    baseline: null,
    after: null,
    patchTestFiles: [],
    stability: [],
    skipChecks: [],
    evidence: [],
    numbers: { backend: emptyNumbers(), frontend: emptyNumbers() },
    patchSha256: patchBuf ? sha256(patchBuf) : null,
    patchEmpty: false,
  }

  const finish = async (): Promise<Verdict> => {
    inp.numbers = buildNumbers(inp, baseCov, afterCov)
    await fs.writeFile(
      path.join(runDir, 'verdict-inputs.json'),
      `${JSON.stringify(inp, null, 2)}\n`,
    )
    const verdict = computeVerdict(inp)
    verdict.reasons.push(...notes.map((n) => `verify: ${n}`))
    return verdict
  }

  try {
    if (plan.earlyOutcome !== null) return await finish()
    // These inputs alone decide the outcome (verdict preVerification): nothing to run.
    if (
      args.agentStop !== 'success' ||
      inp.unguardedToolUses.length > 0 ||
      !reportInput?.ok
    )
      return await finish()
    const report = reportInput.report

    const head = (await git(exec, workDir, ['rev-parse', 'HEAD'])).trim()
    if (head !== plan.headSha) {
      notes.push(
        `work dir is at ${head}, not the analysed head ${plan.headSha}`,
      )
      return await finish()
    }

    // Prisma client for the backend (ADR 0009): head code, so in a container; no secrets.
    // It writes the generated client into work/, which every later sandbox copies.
    log('prisma generate')
    const prismaResults = path.join(runDir, 'results', 'prisma-generate')
    await fs.mkdir(prismaResults, { recursive: true })
    const prisma = await runContainer(
      {
        image: env.image,
        appDir: path.join(workDir, 'backend'),
        resultsDir: prismaResults,
        command: PRISMA_GENERATE,
        network: 'default',
        name: `test-agent-verify-${randomBytes(4).toString('hex')}-prisma-generate`,
        timeoutMs: env.timeoutMs,
        user,
      },
      { exec },
    )
    await writeLog(env, 'prisma-generate', prisma)
    if (prisma.code !== 0 || prisma.timedOut) {
      notes.push(
        `prisma generate failed (${prisma.timedOut ? 'timed out' : `exit ${prisma.code}`})`,
      )
      return await finish()
    }

    // Step 2: baseline (head before the patch).
    const baseline = await runSuites(env, 'baseline', workDir, notes, log)
    if (baseline === null) return await finish()
    inp.baseline = {
      backend: baseline.backend.result,
      frontend: baseline.frontend.result,
    }
    for (const app of APPS) {
      const cov = baseline[app].coverage
      if (cov) baseCov[app] = cov
    }
    if (APPS.some((a) => !inp.baseline![a].typecheck)) return await finish()
    if (APPS.some((a) => inp.baseline![a].suite.failed > 0))
      return await finish()

    // Step 3: patch hash and gates.
    if (patchBuf === null) {
      notes.push('patch file missing')
      return await finish()
    }
    const patchText = patchBuf.toString('utf8')
    const diffs = parseUnifiedDiff(patchText)
    const rejected = patchViolations(
      patchBuf,
      patchText,
      inp.patchSha256!,
      readExpectedSha(await readText(fs, args.patchShaPath)),
      diffs,
      policy,
    )
    if (rejected.length > 0) {
      inp.gates = { ok: false, violations: rejected }
      // Nothing was applied, so nothing strayed outside the gated set.
      inp.appliedPaths = { ok: true, offending: [] }
      return await finish()
    }

    const testDiffs = diffs.filter(
      (d) => d.newPath !== null && isTestPath(policy, d.newPath),
    )
    const evidenceDiffs = diffs.filter(
      (d) => d.newPath !== null && isEvidencePath(policy, d.newPath),
    )
    inp.patchTestFiles = testDiffs.map((d) => ({
      path: d.newPath!,
      status: d.status === 'added' ? 'added' : 'modified',
    }))
    const stripped = stripEvidence(patchText, policy)
    inp.patchEmpty = parseUnifiedDiff(stripped).length === 0

    // Head copies for skip checks and evidence runs, taken before the patch touches work/.
    const applied: Violation[] = []
    const skipRuns = await prepareSkipChecks(env, policy, plan, report, workDir)
    const evidenceRuns = await prepareEvidence(
      env,
      policy,
      evidenceDiffs,
      patchText,
      workDir,
      applied,
    )

    // Citation source for evidence, as on head.
    const openapiText = await readText(
      fs,
      path.join(workDir, 'backend/openapi.json'),
    )

    // Step 4: apply without evidence, then R6 and R12 on what git actually wrote.
    const before = await statusSnapshot(exec, workDir)
    if (!inp.patchEmpty) {
      const file = path.join(runDir, 'patch.applied.diff')
      await fs.writeFile(file, stripped)
      try {
        await gitApply(exec, workDir, file)
      } catch (error) {
        notes.push(`git apply failed: ${(error as Error).message}`)
        inp.gates = { ok: applied.length === 0, violations: applied }
        inp.appliedPaths = { ok: false, offending: [] }
        return await finish()
      }
    }
    inp.appliedPaths = appliedPathsCheck(
      before,
      await statusSnapshot(exec, workDir),
      new Set(testDiffs.map((d) => d.newPath!)),
      policy,
    )
    applied.push(...(await gateApplied(fs, workDir, testDiffs, policy)))
    inp.gates = { ok: applied.length === 0, violations: applied }
    if (!inp.gates.ok || !inp.appliedPaths.ok) return await finish()

    // Step 5: after.
    const after = await runSuites(env, 'after', workDir, notes, log)
    if (after === null) return await finish()
    inp.after = {
      backend: {
        ...after.backend.result,
        expectedFiles: await expectedFiles(fs, workDir, 'backend', policy),
      },
      frontend: {
        ...after.frontend.result,
        expectedFiles: await expectedFiles(fs, workDir, 'frontend', policy),
      },
    }
    for (const app of APPS) {
      const cov = after[app].coverage
      if (cov) afterCov[app] = cov
    }

    // Step 6: stability of every new or changed test file.
    for (const [i, f] of inp.patchTestFiles.entries())
      inp.stability.push(await stability(env, policy, workDir, i, f.path, log))

    // §7.4 skip claims and step 7 evidence, on the head copies.
    inp.skipChecks = await runSkipChecks(
      env,
      policy,
      plan,
      report,
      skipRuns,
      log,
    )
    inp.evidence = await runEvidence(
      env,
      evidenceRuns,
      report,
      plan,
      openapiText,
      log,
    )
    return await finish()
  } finally {
    await fs.rm(path.join(runDir, 'sandbox'), { recursive: true, force: true })
  }
}
