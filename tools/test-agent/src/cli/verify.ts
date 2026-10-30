import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

// Fail closed: node: built-ins only are imported statically; everything else loads inside try.
// Writes verdict.json and exits 0 whatever the outcome; non-zero only on an internal crash.
const AGENT_STOPS = [
  'success',
  'max-turns',
  'max-budget',
  'error',
  'unknown',
  'timeout',
] as const

try {
  const fs = await import('node:fs/promises')
  const { exec } = await import('../exec.ts')
  const { runVerify } = await import('../verify.ts')

  const { values } = parseArgs({
    options: {
      trusted: { type: 'string' },
      work: { type: 'string' },
      'run-dir': { type: 'string' },
      plan: { type: 'string' },
      patch: { type: 'string' },
      'patch-sha256': { type: 'string' },
      report: { type: 'string' },
      transcript: { type: 'string' },
      'guard-log': { type: 'string' },
      'agent-stop': { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  })
  const need = (k: keyof typeof values): string => {
    const v = values[k]
    if (typeof v !== 'string' || v === '') throw new Error(`missing --${k}`)
    return v
  }
  const image = process.env.TEST_AGENT_IMAGE
  if (!image) throw new Error('missing env TEST_AGENT_IMAGE')
  const stop = need('agent-stop')
  // `none`: the agent did not run (plan early outcome).
  if (stop !== 'none' && !(AGENT_STOPS as readonly string[]).includes(stop))
    throw new Error(`invalid --agent-stop: ${stop}`)
  const plan = JSON.parse(readFileSync(need('plan'), 'utf8'))
  if (
    plan === null ||
    typeof plan !== 'object' ||
    !Array.isArray(plan.manifest) ||
    typeof plan.headSha !== 'string' ||
    (plan.mode !== 'pr' && plan.mode !== 'backfill')
  )
    throw new Error('invalid --plan')
  const timeout = process.env.TEST_AGENT_RUN_TIMEOUT_MS
  const timeoutMs = timeout === undefined ? undefined : Number(timeout)
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
  )
    throw new Error('invalid TEST_AGENT_RUN_TIMEOUT_MS')

  const verdict = await runVerify(
    {
      trustedDir: need('trusted'),
      workDir: need('work'),
      runDir: need('run-dir'),
      plan,
      patchPath: need('patch'),
      patchShaPath: need('patch-sha256'),
      reportPath: need('report'),
      transcriptPath: need('transcript'),
      guardLogPath: need('guard-log'),
      agentStop:
        stop === 'none' ? null : (stop as (typeof AGENT_STOPS)[number]),
    },
    {
      exec,
      fs,
      image,
      timeoutMs,
      log: (line) => process.stderr.write(`verify: ${line}\n`),
    },
  )
  writeFileSync(need('out'), `${JSON.stringify(verdict, null, 2)}\n`)
  process.stderr.write(`verify: outcome ${verdict.outcome}\n`)
} catch (error) {
  process.stderr.write(
    `verify failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
}
