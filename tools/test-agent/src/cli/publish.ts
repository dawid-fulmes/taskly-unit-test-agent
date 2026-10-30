import { appendFileSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

// Fail closed: node: built-ins only are imported statically; everything else loads inside try.
// The publish job (spec §6.5): the only holder of the App write token (TEST_AGENT_APP_TOKEN).
// Never runs PR code: only git and the GitHub API. Missing upstream artifacts become an early
// outcome (plan) or `pipeline-error`, so every non-cancelled run reports. Exit non-zero only when
// nothing could be posted.
const SHA = /^[0-9a-f]{40}$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/

const readText = (file: string | undefined): string | null => {
  if (!file) return null
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
const readJson = (file: string | undefined): unknown => {
  const text = readText(file)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

try {
  const { Octokit } = await import('@octokit/rest')
  const { exec } = await import('../exec.ts')
  const { loadPolicy } = await import('../policy.ts')
  const { validateReport } = await import('../report.ts')
  const { summarizeTranscript } = await import('../transcript.ts')
  const { getPull, parseRepo } = await import('../github.ts')
  const {
    earlyVerdict,
    fallbackPlan,
    fallbackVerdict,
    isPlan,
    isVerdict,
    publishRun,
  } = await import('../publish.ts')
  type GitHub = import('../github.ts').GitHub

  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      verdict: { type: 'string' },
      patch: { type: 'string' },
      'patch-sha256': { type: 'string' },
      report: { type: 'string' },
      transcript: { type: 'string' },
      work: { type: 'string' },
      'run-id': { type: 'string' },
      // Fallbacks (workflow inputs confirmed by the filter) when plan.json is missing.
      'pr-number': { type: 'string' },
      'head-sha': { type: 'string' },
      // Backfill: the branch the PR targets.
      'base-ref': { type: 'string' },
    },
    strict: true,
  })
  const need = (k: keyof typeof values): string => {
    const v = values[k]
    if (typeof v !== 'string' || v === '') throw new Error(`missing --${k}`)
    return v
  }
  const env = (k: string): string => {
    const v = process.env[k]
    if (!v) throw new Error(`missing env ${k}`)
    return v
  }
  const token = env('TEST_AGENT_APP_TOKEN')
  const botLogin = env('TEST_AGENT_BOT_LOGIN')
  if (!LOGIN.test(botLogin)) throw new Error('invalid env TEST_AGENT_BOT_LOGIN')
  const repo = parseRepo(process.env.GITHUB_REPOSITORY)
  const runId = need('run-id')
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const runUrl = `${server}/${repo.owner}/${repo.repo}/actions/runs/${env('GITHUB_RUN_ID')}`
  const policy = loadPolicy()
  const log = (line: string) => process.stderr.write(`publish: ${line}\n`)

  const rawPlan = readJson(values.plan)
  let plan
  let verdict
  if (isPlan(rawPlan)) {
    plan = rawPlan
    const rawVerdict = readJson(values.verdict)
    verdict = isVerdict(rawVerdict)
      ? rawVerdict
      : plan.earlyOutcome !== null
        ? earlyVerdict(plan, policy)
        : fallbackVerdict(plan, 'pipeline-error', [
            rawVerdict === null
              ? 'verify produced no verdict (an earlier job failed or was skipped)'
              : 'verdict.json is malformed',
          ])
  } else {
    // Without a plan only a PR run can still be reported, on the filter-confirmed head.
    const prNumber = Number(values['pr-number'])
    const headSha = values['head-sha'] ?? ''
    if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !SHA.test(headSha))
      throw new Error(
        'plan.json missing or invalid and no --pr-number/--head-sha',
      )
    plan = fallbackPlan(prNumber, headSha)
    verdict = fallbackVerdict(plan, 'pipeline-error', [
      'plan produced no valid plan.json',
    ])
  }

  const reportJson = readJson(values.report)
  const report =
    reportJson === null
      ? null
      : (() => {
          const r = validateReport(reportJson)
          return r.ok ? r.report : null
        })()
  const transcript = readText(values.transcript)
  const t = transcript === null ? null : summarizeTranscript(transcript)

  const octokit: GitHub = new Octokit({
    auth: token,
    userAgent: 'test-agent-publish',
  })
  let headRef: string | null = null
  if (plan.mode === 'pr') {
    const pull = await getPull(octokit, repo, plan.prNumber!)
    if (pull === null)
      throw new Error(`pull request ${plan.prNumber} not found`)
    headRef = pull.head.ref
  }

  const result = await publishRun(
    {
      verdict,
      patchPath: values.patch ?? '',
      generateSha256: readText(values['patch-sha256']) ?? '',
      workDir: need('work'),
      plan,
      runId,
      botName: env('TEST_AGENT_BOT_NAME'),
      botEmail: env('TEST_AGENT_BOT_EMAIL'),
      botLogin,
      headRef,
      baseRef: plan.mode === 'backfill' ? need('base-ref') : null,
      report,
      meta: {
        runUrl,
        model: process.env.TEST_AGENT_MODEL ?? 'unknown',
        budgetProfile: plan.budgetProfile,
        skills: t?.skills ?? null,
        turns: t?.turns ?? null,
        costUsd: t?.costUsd ?? null,
      },
    },
    { exec, octokit, repo, policy, log },
  )
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) appendFileSync(summary, result.comment)
  log(
    `outcome ${result.outcome}; check ${result.checkSha ?? 'none'}; PR ${result.prNumber ?? 'none'}`,
  )
} catch (error) {
  process.stderr.write(
    `publish failure: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
