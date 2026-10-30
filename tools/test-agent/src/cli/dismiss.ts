import { parseArgs } from 'node:util'

// Fail closed: node: built-ins only are imported statically; everything else loads inside try.
// The dismiss job (spec §6.6): App token from TEST_AGENT_APP_TOKEN, no checkout of PR code.
// `--labeler` must be `workflow_run.triggering_actor`, never a value from the trigger artifact.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/

try {
  const { Octokit } = await import('@octokit/rest')
  const { runDismiss } = await import('../dismiss.ts')
  const { parseRepo } = await import('../github.ts')
  type GitHub = import('../github.ts').GitHub

  const { values } = parseArgs({
    options: {
      'pr-number': { type: 'string' },
      labeler: { type: 'string' },
    },
    strict: true,
  })
  const prNumber = Number(values['pr-number'])
  if (!Number.isSafeInteger(prNumber) || prNumber < 1)
    throw new Error('invalid --pr-number')
  const labeler = values.labeler ?? ''
  if (!LOGIN.test(labeler)) throw new Error('invalid --labeler')
  const token = process.env.TEST_AGENT_APP_TOKEN
  if (!token) throw new Error('missing env TEST_AGENT_APP_TOKEN')
  const botLogin = process.env.TEST_AGENT_BOT_LOGIN ?? ''
  if (!LOGIN.test(botLogin)) throw new Error('invalid env TEST_AGENT_BOT_LOGIN')
  const appId = Number(process.env.TEST_AGENT_APP_ID)
  if (!Number.isSafeInteger(appId) || appId < 1)
    throw new Error('invalid env TEST_AGENT_APP_ID')
  const repo = parseRepo(process.env.GITHUB_REPOSITORY)
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const runId = process.env.GITHUB_RUN_ID ?? ''
  if (!/^\d+$/.test(runId)) throw new Error('invalid env GITHUB_RUN_ID')

  const octokit: GitHub = new Octokit({
    auth: token,
    userAgent: 'test-agent-dismiss',
  })
  await runDismiss(
    {
      prNumber,
      labeler,
      botLogin,
      appId,
      runUrl: `${server}/${repo.owner}/${repo.repo}/actions/runs/${runId}`,
    },
    {
      octokit,
      repo,
      log: (line) => process.stderr.write(`${line}\n`),
    },
  )
} catch (error) {
  process.stderr.write(
    `dismiss failure: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
