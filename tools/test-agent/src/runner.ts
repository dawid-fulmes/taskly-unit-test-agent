import path from 'node:path'
import { exec, type ExecOptions, type ExecResult } from './exec.ts'
import { isEvidencePath, isTestPath, type Policy } from './policy.ts'
import type { App } from './types.ts'

export interface ContainerRun {
  image: string
  appDir: string
  resultsDir: string
  command: string[]
  env?: Record<string, string>
  network: 'none' | 'default'
  /** Unique container name, used to kill it on timeout. */
  name: string
  timeoutMs: number
  /** `${uid}:${gid}`; never root. */
  user: string
}

// Same character class as the guard's Bash pattern.
const FILE_PATTERN = /^[A-Za-z0-9_./@-]+$/

/** Accepts exactly the inputs the guard's Bash rule accepts; throws on anything else. */
export function parseRunnerArgs(
  argv: string[],
  policy: Policy,
): { app: App; files: string[] } {
  const [app, ...files] = argv
  if (app !== 'backend' && app !== 'frontend') {
    throw new Error(`unknown app: ${String(app)}`)
  }
  if (files.length === 0) throw new Error('no test files given')
  for (const file of files) {
    if (!FILE_PATTERN.test(file)) throw new Error(`invalid characters: ${file}`)
    if (file.startsWith('-'))
      throw new Error(`option argument rejected: ${file}`)
    if (path.posix.isAbsolute(file) || file.split('/').includes('..')) {
      throw new Error(`path escapes the app dir: ${file}`)
    }
    if (path.posix.normalize(file) !== file) {
      throw new Error(`non-canonical path: ${file}`)
    }
    const repoPath = `${app}/${file}`
    if (!isTestPath(policy, repoPath) && !isEvidencePath(policy, repoPath)) {
      throw new Error(`not a test or evidence file: ${file}`)
    }
  }
  return { app, files }
}

/** Docker argv for a network-isolated run. No host environment variable is passed through. */
export function dockerArgv(run: ContainerRun): string[] {
  const { TZ = 'UTC', ...extra } = run.env ?? {}
  const envArgs = Object.entries(extra).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ])
  return [
    'run',
    '--rm',
    '--init',
    '--name',
    run.name,
    '--network',
    run.network,
    '--user',
    run.user,
    '--memory',
    '4g',
    '--cpus',
    '2',
    '--pids-limit',
    '512',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--env-file',
    '/dev/null',
    '-e',
    `TZ=${TZ}`,
    '-e',
    'HOME=/tmp',
    '-e',
    'CI=1',
    ...envArgs,
    '-v',
    `${run.appDir}:/app`,
    '-v',
    `${run.resultsDir}:/results`,
    '-w',
    '/app',
    run.image,
    ...run.command,
  ]
}

export function vitestCommand(opts: {
  files?: string[]
  coverage?: boolean
  seed?: number
  shuffle?: boolean
  outputName: string
}): string[] {
  const command = [
    'npx',
    'vitest',
    'run',
    '--reporter=json',
    `--outputFile=/results/${opts.outputName}.json`,
  ]
  if (opts.coverage) {
    command.push(
      '--coverage.enabled=true',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=/results/${opts.outputName}-coverage`,
    )
  }
  if (opts.shuffle) {
    command.push('--sequence.shuffle=true', `--sequence.seed=${opts.seed ?? 1}`)
  }
  command.push(...(opts.files ?? []))
  return command
}

export interface RunContainerDeps {
  exec: (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>
}

/** Runs the container; on timeout kills it by name (killing the docker client alone would not). */
export async function runContainer(
  run: ContainerRun,
  deps: RunContainerDeps = { exec },
): Promise<ExecResult> {
  const result = await deps.exec('docker', dockerArgv(run), {
    timeoutMs: run.timeoutMs,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  })
  if (result.timedOut) await deps.exec('docker', ['kill', run.name])
  return result
}
