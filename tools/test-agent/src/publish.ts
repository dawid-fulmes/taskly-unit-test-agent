import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  headFromComment,
  renderComment,
  verdictLine,
  withHeadMarker,
  withOutcomeMarker,
  type RunMeta,
} from './comment.ts'
import { parseUnifiedDiff, type FileDiff } from './diff.ts'
import { RETRY_LARGE_LABEL } from './filter.ts'
import { stripEvidence } from './gates.ts'
import {
  createCheckRun,
  getPull,
  openPullRequest,
  removeLabel,
  upsertComment,
  withRetry,
  type GitHub,
  type Repo,
} from './github.ts'
import {
  isEvidencePath,
  isTestPath,
  loadPolicy,
  type Policy,
} from './policy.ts'
import type { Report } from './report.ts'
import type { App, Conclusion, Outcome, Plan } from './types.ts'
import { computeVerdict, conclusionFor, type Verdict } from './verdict.ts'
import { gateApplied, patchViolations, readExpectedSha } from './verify.ts'
import {
  appliedPathsCheck,
  git,
  gitApply,
  gitResult,
  statusSnapshot,
} from './verify/git.ts'
import { emptyNumbers } from './verify/numbers.ts'
import type { Exec } from './verify/sandbox.ts'

export interface PublishArgs {
  verdict: Verdict
  /** The patch from the `generate` artifact. */
  patchPath: string
  /** sha256 reported by `generate` (bare hex or `sha256sum` format). */
  generateSha256: string
  /** Git checkout of the analysed head (pr) or base (backfill); never run, only patched. */
  workDir: string
  plan: Plan
  runId: string
  botName: string
  botEmail: string
  /** Login of our App's bot user; identifies our sticky comment. */
  botLogin: string
  /** pr mode: the PR head branch the bot commit is pushed to. */
  headRef: string | null
  /** backfill mode: the branch the backfill PR targets. */
  baseRef: string | null
  report: Report | null
  meta: RunMeta
}

export interface PublishDeps {
  exec: Exec
  octokit: GitHub
  repo: Repo
  /** Trusted policy; defaults to the package's own policy.json. */
  policy?: Policy
  log?: (line: string) => void
  /** Backoff between GitHub API retries; injected by tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface PublishResult {
  outcome: Outcome
  /** SHA the check run was created on; null when none was created (head moved, backfill without PR). */
  checkSha: string | null
  /** PR the comment went to; null for a backfill run that opened no PR. */
  prNumber: number | null
  /** The rendered comment (also for the job summary). */
  comment: string
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// Hooks and signing are disabled for every git command that could trigger them.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false']
const PUSH_REJECTED = /\((stale info|fetch first|non-fast-forward)\)/

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

export function commitMessage(
  prNumber: number | null,
  app: App | null,
  runId: string,
): string {
  if (!RUN_ID.test(runId)) throw new Error('invalid run id')
  let subject: string
  if (prNumber !== null) {
    if (!Number.isSafeInteger(prNumber) || prNumber < 1)
      throw new Error('invalid PR number')
    subject = `test(agent): add unit tests for #${prNumber}`
  } else if (app === 'backend' || app === 'frontend')
    subject = `test(agent): backfill ${app} unit tests`
  else throw new Error('commit message needs a PR number or an app')
  return `${subject}\n\nTest-Agent-Run: ${runId}`
}

/** A conservative subset of `git check-ref-format` for branch names. */
export function validBranch(b: string): boolean {
  return (
    b.length > 0 &&
    b.length <= 200 &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(b) &&
    !b.startsWith('-') &&
    !b.startsWith('/') &&
    !b.endsWith('/') &&
    !b.endsWith('.') &&
    !b.endsWith('.lock') &&
    !b.includes('..') &&
    !b.includes('//') &&
    !b.includes('@{') &&
    b !== '@' &&
    !b.split('/').some((c) => c.startsWith('.'))
  )
}

function validIdentity(s: string): boolean {
  return s.trim() !== '' && s.length <= 200 && !/[\x00-\x1f\x7f<>]/.test(s)
}

const emptyBanners = (plan: Plan): Verdict['banners'] => ({
  dependenciesChanged: plan.dependenciesChanged,
  testsRemovedByAuthor: plan.testsRemovedByAuthor.map((t) => ({ ...t })),
  configChanged: plan.earlyOutcome === 'config-changed',
})

/** A verdict decided by the pipeline itself (crashed job, missing verdict, publish rejection). */
export function fallbackVerdict(
  plan: Plan,
  outcome: Outcome,
  reasons: string[],
): Verdict {
  const conclusion = conclusionFor(outcome, plan.mode)
  return {
    mode: plan.mode,
    outcome,
    conclusion: conclusion === 'unaffected' ? 'neutral' : conclusion,
    commitAllowed: false,
    patchSha256: null,
    reasons,
    files: [],
    defects: [],
    numbers: { backend: emptyNumbers(), frontend: emptyNumbers() },
    banners: emptyBanners(plan),
    baselineFailures: [],
  }
}

/** The verdict for a plan early outcome, when generate and verify were skipped. */
export function earlyVerdict(plan: Plan, policy: Policy): Verdict {
  if (plan.earlyOutcome === null) throw new Error('plan has no early outcome')
  return computeVerdict({
    plan,
    policy,
    agentStop: null,
    report: null,
    gates: null,
    appliedPaths: null,
    unguardedToolUses: [],
    baseline: null,
    after: null,
    patchTestFiles: [],
    stability: [],
    skipChecks: [],
    evidence: [],
    numbers: { backend: emptyNumbers(), frontend: emptyNumbers() },
    patchSha256: null,
    patchEmpty: true,
  })
}

/** Minimal plan when the plan job produced none: enough to report `pipeline-error` on the PR. */
export function fallbackPlan(prNumber: number, headSha: string): Plan {
  return {
    mode: 'pr',
    prNumber,
    baseSha: '',
    headSha,
    title: '',
    description: '',
    draft: false,
    earlyOutcome: null,
    manifest: [],
    dependenciesChanged: false,
    testsRemovedByAuthor: [],
    budgetProfile: 'default',
  }
}

/** Never trusts the verdict's own conclusion or commit flag beyond what its outcome allows. */
function normalizeVerdict(v: Verdict, plan: Plan): Verdict {
  if (v.mode !== plan.mode)
    return fallbackVerdict(plan, 'pipeline-error', [
      'publish: verdict mode differs from the plan',
    ])
  const conclusion = conclusionFor(v.outcome, plan.mode) as
    Conclusion | 'unaffected' | undefined
  if (conclusion === undefined || conclusion === 'unaffected')
    return fallbackVerdict(plan, 'pipeline-error', [
      `publish: verdict outcome ${String(v.outcome)} is invalid for ${plan.mode} mode`,
    ])
  return {
    ...v,
    conclusion,
    commitAllowed:
      v.commitAllowed === true &&
      (v.outcome === 'tests-added' || v.outcome === 'defect'),
  }
}

function override(v: Verdict, outcome: Outcome, reasons: string[]): Verdict {
  const c = conclusionFor(outcome, v.mode)
  return {
    ...v,
    outcome,
    conclusion: c === 'unaffected' ? 'neutral' : c,
    commitAllowed: false,
    reasons: [...reasons, ...v.reasons],
  }
}

function backfillApp(plan: Plan): App | null {
  const apps = new Set(plan.manifest.map((m) => m.app))
  return apps.size === 1 ? [...apps][0]! : null
}

/** Evidence test sources for the comment, from the hash-checked patch (data only). */
function evidenceSources(
  diffs: FileDiff[],
  v: Verdict,
  policy: Policy,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of v.defects) {
    const diff = diffs.find(
      (x) =>
        x.newPath === d.evidenceTest &&
        x.status === 'added' &&
        isEvidencePath(policy, d.evidenceTest),
    )
    if (diff) out[d.evidenceTest] = diff.added.map((l) => l.text).join('\n')
  }
  return out
}

type CommitResult =
  { ok: true; sha: string } | { ok: false; outcome: Outcome; reasons: string[] }

/**
 * Re-checks the patch as data (hash, gates), applies it without evidence, re-checks what git
 * really changed (R6, R12), commits as the App and pushes with compare-and-swap. Only git runs.
 */
async function commitAndPush(
  args: PublishArgs,
  deps: PublishDeps,
  policy: Policy,
  v: Verdict,
  patch: Buffer | null,
  branch: string,
  message: string,
): Promise<CommitResult> {
  const { exec } = deps
  const { plan, workDir } = args
  const log = deps.log ?? (() => {})
  const reject = (reasons: string[]): CommitResult => ({
    ok: false,
    outcome: 'patch-rejected',
    reasons,
  })
  const failed = (reason: string): CommitResult => ({
    ok: false,
    outcome: 'pipeline-error',
    reasons: [`publish: ${reason}`],
  })

  if (patch === null) return reject(['publish: patch file missing'])
  const actual = sha256(patch)
  if (actual !== v.patchSha256)
    return reject([
      `publish: patch sha256 ${actual} differs from the verified ${v.patchSha256 ?? '(none)'}`,
    ])
  const text = patch.toString('utf8')
  const diffs = parseUnifiedDiff(text)
  const violations = patchViolations(
    patch,
    text,
    actual,
    readExpectedSha(args.generateSha256),
    diffs,
    policy,
  )
  if (violations.length > 0)
    return reject(
      violations.map((x) => `publish: ${x.file}: ${x.rule} (${x.detail})`),
    )
  const stripped = stripEvidence(text, policy)
  const testDiffs = diffs.filter(
    (d) => d.newPath !== null && isTestPath(policy, d.newPath),
  )
  const testPaths = testDiffs.map((d) => d.newPath!)
  if (parseUnifiedDiff(stripped).length === 0 || testPaths.length === 0)
    return failed('commit allowed but the patch has no test files')

  const head = (await git(exec, workDir, ['rev-parse', 'HEAD'])).trim()
  if (head !== plan.headSha)
    return failed(`work dir is at ${head}, not the analysed ${plan.headSha}`)
  const before = await statusSnapshot(exec, workDir)
  if (before.some((e) => e.code !== '!!'))
    return failed('work tree is not clean before applying the patch')

  const tmp = await fs.mkdtemp(path.join(tmpdir(), 'test-agent-publish-'))
  try {
    const file = path.join(tmp, 'patch.applied.diff')
    await fs.writeFile(file, stripped)
    try {
      await gitApply(exec, workDir, file)
    } catch (error) {
      log(`git apply failed: ${(error as Error).message}`)
      return reject(['publish: git apply failed'])
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }

  // R6: the real changed-path set, as in verify.
  const applied = appliedPathsCheck(
    before,
    await statusSnapshot(exec, workDir),
    new Set(testPaths),
    policy,
  )
  if (!applied.ok)
    return reject(
      applied.offending.map(
        (p) => `publish: ${p}: changed by git apply outside the gated set`,
      ),
    )
  // R12: content gates on the files as git wrote them.
  const content = await gateApplied(fs, workDir, testDiffs, policy)
  if (content.length > 0)
    return reject(
      content.map((x) => `publish: ${x.file}: ${x.rule} (${x.detail})`),
    )

  // Deterministic commit: fixed identity and the analysed head's committer date, so a re-run of
  // this job rebuilds the same SHA and its push is a no-op instead of a stale-lease rejection.
  const committed = (
    await git(exec, workDir, ['log', '-1', '--format=%ct', plan.headSha])
  ).trim()
  if (!/^\d+$/.test(committed))
    return failed('cannot read the analysed head commit date')
  const date = `@${committed} +0000`
  const identity = {
    GIT_AUTHOR_NAME: args.botName,
    GIT_AUTHOR_EMAIL: args.botEmail,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: args.botName,
    GIT_COMMITTER_EMAIL: args.botEmail,
    GIT_COMMITTER_DATE: date,
  }
  await git(exec, workDir, ['add', '--force', '--', ...testPaths])
  await git(
    exec,
    workDir,
    [...SAFE, 'commit', '--no-verify', '--quiet', '-m', message],
    identity,
  )
  const sha = (await git(exec, workDir, ['rev-parse', 'HEAD'])).trim()
  // The commit must change exactly the gated test files, nothing else.
  const changed = (
    await git(exec, workDir, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      '-z',
      '--no-renames',
      sha,
    ])
  )
    .split('\0')
    .filter((p) => p !== '')
  const expected = new Set(testPaths)
  if (changed.length !== expected.size || changed.some((p) => !expected.has(p)))
    return reject(['publish: the commit does not match the gated test files'])
  // The committed blobs must be the bytes the gates saw: `.gitattributes` (text, eol, ident,
  // working-tree-encoding) can make `git add` store something else.
  for (const p of testPaths) {
    const blob = (
      await git(exec, workDir, ['rev-parse', '--verify', `${sha}:${p}`])
    ).trim()
    const raw = (
      await git(exec, workDir, ['hash-object', '--no-filters', '--', p])
    ).trim()
    if (blob !== raw)
      return reject([
        `publish: ${p}: committed blob differs from the gated bytes (.gitattributes conversion)`,
      ])
  }

  const lease =
    plan.mode === 'pr'
      ? `--force-with-lease=refs/heads/${branch}:${plan.headSha}`
      : // Backfill: the branch must not exist yet.
        `--force-with-lease=refs/heads/${branch}:`
  const push = await gitResult(exec, workDir, [
    ...SAFE,
    'push',
    '--no-verify',
    'origin',
    `HEAD:refs/heads/${branch}`,
    lease,
  ])
  if (push.timedOut) {
    // The push may still have landed: trust only what the remote now has.
    log('git push timed out; checking the remote branch')
    const remote = await gitResult(exec, workDir, [
      'ls-remote',
      'origin',
      `refs/heads/${branch}`,
    ])
    const at = remote.code === 0 ? remote.stdout.trim().split(/\s+/)[0] : null
    if (at === sha) return { ok: true, sha }
    return failed('git push timed out')
  }
  if (push.code !== 0) {
    log(`git push failed (code ${push.code}): ${push.stderr.slice(0, 500)}`)
    if (plan.mode === 'pr' && PUSH_REJECTED.test(push.stderr))
      return {
        ok: false,
        outcome: 'head-moved',
        reasons: [
          `The PR head moved after the analysed commit ${plan.headSha}, so nothing was pushed. A new run reports on the new head.`,
        ],
      }
    return failed('git push failed')
  }
  return { ok: true, sha }
}

function checkSummary(v: Verdict): string {
  return `Outcome \`${v.outcome}\` (${v.conclusion}). Details are in the test-agent comment on the pull request and in the linked run.`
}

/**
 * The `publish` job (spec §6.5). Holds the only write token and never runs PR code: it treats
 * the patch as data, uses git and the GitHub API only, and posts the check run and comment.
 */
export async function publishRun(
  args: PublishArgs,
  deps: PublishDeps,
): Promise<PublishResult> {
  const policy = deps.policy ?? loadPolicy()
  const { plan } = args
  const o = deps.octokit
  // Everything that reaches git argv or the commit is validated before any git command.
  if (!RUN_ID.test(args.runId)) throw new Error('invalid run id')
  if (!validIdentity(args.botName) || !validIdentity(args.botEmail))
    throw new Error('invalid bot identity')
  if (!validIdentity(args.botLogin)) throw new Error('invalid bot login')
  if (plan.mode === 'pr') {
    if (plan.prNumber === null) throw new Error('pr mode without a PR number')
    if (args.headRef === null || !validBranch(args.headRef))
      throw new Error('invalid head ref')
  } else if (args.baseRef === null || !validBranch(args.baseRef))
    throw new Error('invalid base ref')

  let v = normalizeVerdict(args.verdict, plan)
  const patch = await fs.readFile(args.patchPath).catch(() => null)
  const actual = patch ? sha256(patch) : null
  const hashOk =
    actual !== null &&
    actual === readExpectedSha(args.generateSha256) &&
    actual === v.patchSha256
  let pushedSha: string | null = null
  let branch: string | null = null

  if (v.commitAllowed) {
    let result: CommitResult
    const app = plan.mode === 'backfill' ? backfillApp(plan) : null
    if (!hashOk)
      result = {
        ok: false,
        outcome: 'patch-rejected',
        reasons: [
          patch === null
            ? 'publish: patch file missing'
            : 'publish: patch sha256 does not match the generate and verify hashes',
        ],
      }
    else if (plan.mode === 'backfill' && app === null)
      result = {
        ok: false,
        outcome: 'pipeline-error',
        reasons: ['publish: backfill manifest does not name exactly one app'],
      }
    else {
      branch =
        plan.mode === 'pr'
          ? args.headRef!
          : `test-agent/backfill-${app}-${args.runId}`
      try {
        result = await commitAndPush(
          args,
          deps,
          policy,
          v,
          patch,
          branch,
          commitMessage(
            plan.mode === 'pr' ? plan.prNumber : null,
            app,
            args.runId,
          ),
        )
      } catch (error) {
        deps.log?.(`publish git step failed: ${(error as Error).message}`)
        result = {
          ok: false,
          outcome: 'pipeline-error',
          reasons: ['publish: a git step failed'],
        }
      }
    }
    if (result.ok) pushedSha = result.sha
    else v = override(v, result.outcome, result.reasons)
  }

  const evidence =
    hashOk && patch
      ? evidenceSources(parseUnifiedDiff(patch.toString('utf8')), v, policy)
      : {}
  let body: string
  try {
    body = withOutcomeMarker(
      renderComment(v, args.report, args.meta, evidence),
      v.outcome,
    )
  } catch (error) {
    deps.log?.(`render failed: ${(error as Error).message}`)
    v = fallbackVerdict(plan, 'pipeline-error', [
      'publish: the verdict could not be rendered',
    ])
    body = withOutcomeMarker(renderComment(v, null, args.meta), v.outcome)
  }

  // The SHA this run reports on: its bot commit if it pushed one, otherwise the analysed head.
  const reportedSha = pushedSha ?? plan.headSha
  body = withHeadMarker(body, reportedSha)
  const log = deps.log ?? (() => {})
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const retry = <T>(fn: () => Promise<T>) => withRetry(fn, sleep)

  if (plan.mode === 'backfill' && (pushedSha === null || branch === null))
    // Nothing reached a branch: there is no PR to report on (the job summary shows the comment).
    return { outcome: v.outcome, checkSha: null, prNumber: null, comment: body }

  try {
    let prNumber: number
    if (plan.mode === 'backfill') {
      const app = backfillApp(plan)!
      prNumber = await retry(() =>
        openPullRequest(
          o,
          deps.repo,
          branch!,
          args.baseRef!,
          `test(agent): backfill ${app} unit tests`,
          `Backfill of ${app} unit tests by the test agent (run ${args.runId}).\n\nThe tests were verified before this branch was pushed; the test-agent comment below has the details.\n`,
        ),
      )
    } else prNumber = plan.prNumber!

    // Review Focus 5: when the head moved, no check run is created by this run at all
    // (not on the old SHA, and the new head belongs to the newer run).
    const checkSha =
      v.outcome === 'head-moved' ? null : (pushedSha ?? plan.headSha)
    if (checkSha !== null)
      await retry(() =>
        createCheckRun(
          o,
          deps.repo,
          checkSha,
          v.conclusion,
          verdictLine(v.outcome),
          checkSummary(v),
          args.meta.runUrl,
        ),
      )
    // Never overwrite a newer run's comment. Ours (same analysed head or same reported SHA) is
    // replaced. A head-moved run is stale by definition, so it keeps any comment about another
    // head; any other run keeps a comment whose SHA is the PR's current head (a newer run's,
    // possibly its bot commit).
    const keepNewer = async (existing: string): Promise<boolean> => {
      const prev = headFromComment(existing)
      if (
        plan.mode !== 'pr' ||
        prev === null ||
        prev === plan.headSha ||
        prev === reportedSha
      )
        return false
      if (v.outcome !== 'head-moved') {
        const pull = await getPull(o, deps.repo, prNumber)
        if (pull?.head.sha !== prev) return false
      }
      log(`kept the newer comment for ${prev}`)
      return true
    }
    await retry(() =>
      upsertComment(o, deps.repo, prNumber, body, args.botLogin, keepNewer),
    )
    if (plan.mode === 'pr')
      await retry(() =>
        removeLabel(o, deps.repo, prNumber, RETRY_LARGE_LABEL),
      ).catch((error: unknown) =>
        log(
          `could not remove ${RETRY_LARGE_LABEL}: ${(error as Error).message}`,
        ),
      )
    return { outcome: v.outcome, checkSha, prNumber, comment: body }
  } catch (error) {
    if (pushedSha === null) throw error
    throw new Error(
      `pushed ${pushedSha} to ${branch} but reporting to GitHub failed (${(error as Error).message}); re-run the publish job: it rebuilds the same commit and finishes reporting.`,
    )
  }
}

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
const isStr = (x: unknown): x is string => typeof x === 'string'
const isStrArray = (x: unknown) => Array.isArray(x) && x.every(isStr)

/** Shape check for `verdict.json` from the verify job; rendering errors are caught separately. */
export function isVerdict(x: unknown): x is Verdict {
  if (!isObj(x)) return false
  const b = x.banners
  return (
    (x.mode === 'pr' || x.mode === 'backfill') &&
    isStr(x.outcome) &&
    isStr(x.conclusion) &&
    typeof x.commitAllowed === 'boolean' &&
    (x.patchSha256 === null || isStr(x.patchSha256)) &&
    isStrArray(x.reasons) &&
    Array.isArray(x.files) &&
    x.files.every(
      (f) => isObj(f) && isStr(f.path) && isStr(f.action) && isStr(f.details),
    ) &&
    Array.isArray(x.defects) &&
    x.defects.every(
      (d) =>
        isObj(d) &&
        isStr(d.file) &&
        isStr(d.evidenceTest) &&
        isStr(d.citation) &&
        typeof d.accepted === 'boolean',
    ) &&
    isObj(x.numbers) &&
    isObj(x.numbers.backend) &&
    isObj(x.numbers.frontend) &&
    isObj(b) &&
    typeof b.dependenciesChanged === 'boolean' &&
    Array.isArray(b.testsRemovedByAuthor) &&
    typeof b.configChanged === 'boolean' &&
    Array.isArray(x.baselineFailures)
  )
}

const SHA = /^[0-9a-f]{40}$/
const EARLY = new Set(['draft', 'config-changed', 'nothing-to-test'])
const PROFILES = new Set(['default', 'large', 'backfill'])

/** Shape check for `plan.json` from the plan job. */
export function isPlan(x: unknown): x is Plan {
  if (!isObj(x)) return false
  return (
    (x.mode === 'pr' || x.mode === 'backfill') &&
    (x.mode === 'pr'
      ? Number.isSafeInteger(x.prNumber) && (x.prNumber as number) > 0
      : x.prNumber === null) &&
    isStr(x.baseSha) &&
    isStr(x.headSha) &&
    SHA.test(x.headSha) &&
    isStr(x.title) &&
    isStr(x.description) &&
    typeof x.draft === 'boolean' &&
    (x.earlyOutcome === null ||
      (isStr(x.earlyOutcome) && EARLY.has(x.earlyOutcome))) &&
    Array.isArray(x.manifest) &&
    x.manifest.every(
      (m) =>
        isObj(m) &&
        isStr(m.path) &&
        (m.app === 'backend' || m.app === 'frontend') &&
        Array.isArray(m.changedLines),
    ) &&
    typeof x.dependenciesChanged === 'boolean' &&
    Array.isArray(x.testsRemovedByAuthor) &&
    x.testsRemovedByAuthor.every(
      (t) => isObj(t) && isStr(t.file) && typeof t.count === 'number',
    ) &&
    isStr(x.budgetProfile) &&
    PROFILES.has(x.budgetProfile)
  )
}
