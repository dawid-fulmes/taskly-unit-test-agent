import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Only node: built-ins are imported statically; everything else is loaded inside the try block
// so that any load-time failure exits non-zero without running Docker.

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing env ${name}`)
  return value
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

let resultsDir: string | null = null
try {
  const { loadPolicy } = await import('../policy.ts')
  const { parseRunnerArgs, runContainer, vitestCommand } =
    await import('../runner.ts')
  const workDir = requireEnv('TEST_AGENT_WORK_DIR')
  requireEnv('TEST_AGENT_TRUSTED_DIR')
  const image = requireEnv('TEST_AGENT_IMAGE')
  const { app, files } = parseRunnerArgs(process.argv.slice(2), loadPolicy())
  resultsDir = mkdtempSync(path.join(tmpdir(), 'test-agent-results-'))
  const timeoutMs = Number(
    process.env.TEST_AGENT_RUN_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  )
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('invalid TEST_AGENT_RUN_TIMEOUT_MS')
  }
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error('uid/gid unavailable')
  }
  const result = await runContainer({
    image,
    appDir: path.join(workDir, app),
    resultsDir,
    command: vitestCommand({ files, outputName: 'run' }),
    network: 'none',
    name: `test-agent-${process.pid}-${randomBytes(4).toString('hex')}`,
    timeoutMs,
    user: `${process.getuid()}:${process.getgid()}`,
  })
  if (result.timedOut) throw new Error(`timed out after ${timeoutMs} ms`)
  let json = ''
  try {
    json = readFileSync(path.join(resultsDir, 'run.json'), 'utf8')
  } catch {
    // Vitest produced no report (crash, config error): surface its output instead.
  }
  if (json !== '') process.stdout.write(json)
  else process.stderr.write(result.stdout + result.stderr)
  process.exitCode = result.code === 0 ? 0 : 1
} catch (error) {
  process.stderr.write(
    `runner failure: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 2
} finally {
  if (resultsDir !== null) rmSync(resultsDir, { recursive: true, force: true })
}
