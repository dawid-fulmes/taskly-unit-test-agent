import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

// Fail closed: node: built-ins only are imported statically; everything else loads inside try.
// The filter job of test-agent-pr.yml (spec §6.1, ADR 0020). Read-only GITHUB_TOKEN; no secrets.
// `--trigger` is the untrusted trigger.json artifact: {"prNumber", "headSha", "action", "label"?}.
// Writes `path`, `reason`, `budget_profile`, `pr_number`, `head_sha` to --out (JSON) and to
// $GITHUB_OUTPUT. Exits 0 with path=stop for anything it rejects; non-zero only on a crash,
// which leaves the outputs unset so nothing downstream runs.
const SHA = /^[0-9a-f]{40}$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/

// Output values never carry newlines or non-ASCII: they end up in $GITHUB_OUTPUT.
const clean = (v: string) => v.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)

try {
  const { Octokit } = await import('@octokit/rest')
  const { decideTrigger } = await import('../filter.ts')
  const { commitMessageOf, getPull, parseRepo } = await import('../github.ts')
  type GitHub = import('../github.ts').GitHub

  const { values } = parseArgs({
    options: {
      trigger: { type: 'string' },
      'workflow-run-head-sha': { type: 'string' },
      'triggering-actor': { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  })
  const need = (k: keyof typeof values): string => {
    const v = values[k]
    if (typeof v !== 'string' || v === '') throw new Error(`missing --${k}`)
    return v
  }
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('missing env GITHUB_TOKEN')
  const botLogin = process.env.TEST_AGENT_BOT_LOGIN ?? ''
  if (!LOGIN.test(botLogin)) throw new Error('invalid env TEST_AGENT_BOT_LOGIN')
  const repo = parseRepo(process.env.GITHUB_REPOSITORY)
  const runHead = need('workflow-run-head-sha')
  const actor = need('triggering-actor')
  if (!SHA.test(runHead)) throw new Error('invalid --workflow-run-head-sha')
  if (!LOGIN.test(actor)) throw new Error('invalid --triggering-actor')

  const emit = (o: Record<string, string>) => {
    const out = Object.fromEntries(
      Object.entries(o).map(([k, v]) => [k, clean(v)]),
    )
    writeFileSync(need('out'), `${JSON.stringify(out, null, 2)}\n`)
    const gh = process.env.GITHUB_OUTPUT
    if (gh)
      appendFileSync(
        gh,
        Object.entries(out)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
      )
    process.stderr.write(`filter: ${out.path} (${out.reason})\n`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(need('trigger'), 'utf8'))
  } catch {
    raw = null
  }
  const t = raw as Record<string, unknown> | null
  const valid =
    t !== null &&
    typeof t === 'object' &&
    Number.isSafeInteger(t.prNumber) &&
    (t.prNumber as number) > 0 &&
    typeof t.headSha === 'string' &&
    SHA.test(t.headSha) &&
    typeof t.action === 'string' &&
    /^[a-z_]{1,32}$/.test(t.action) &&
    (t.label === undefined ||
      t.label === null ||
      (typeof t.label === 'string' && t.label.length <= 100))
  if (!valid) {
    emit({
      path: 'stop',
      reason: 'invalid trigger artifact',
      budget_profile: 'default',
      pr_number: '',
      head_sha: '',
    })
  } else {
    const trigger = {
      prNumber: t.prNumber as number,
      headSha: t.headSha as string,
      action: t.action as string,
      ...(typeof t.label === 'string' ? { label: t.label } : {}),
    }
    const octokit: GitHub = new Octokit({
      auth: token,
      userAgent: 'test-agent-filter',
    })
    const pull = await getPull(octokit, repo, trigger.prNumber)
    const headCommitMessage = pull
      ? await commitMessageOf(octokit, repo, pull.head.sha)
      : ''
    const decision = decideTrigger({
      trigger,
      workflowRun: { headSha: runHead, triggeringActor: actor },
      pr: pull && {
        headSha: pull.head.sha,
        headRepo: pull.head.repo?.full_name ?? '',
        baseRepo: pull.base.repo.full_name,
        draft: pull.draft === true,
        labels: pull.labels
          .map((l) => l.name)
          .filter((n): n is string => typeof n === 'string'),
        author: pull.user?.login ?? '',
      },
      headCommitMessage,
      botLogin,
    })
    const go = decision.path !== 'stop'
    emit({
      path: decision.path,
      reason: decision.reason,
      budget_profile: decision.budgetProfile,
      // Only API-confirmed values are passed on.
      pr_number: go ? String(trigger.prNumber) : '',
      head_sha: go && pull ? pull.head.sha : '',
    })
  }
} catch (error) {
  process.stderr.write(
    `filter failure: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
