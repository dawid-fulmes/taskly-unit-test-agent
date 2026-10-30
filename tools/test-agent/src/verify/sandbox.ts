import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import path from 'node:path'
import type { ExecOptions, ExecResult } from '../exec.ts'
import { runContainer } from '../runner.ts'
import type { App } from '../types.ts'

export type Exec = (
  cmd: string,
  args: string[],
  opts?: ExecOptions,
) => Promise<ExecResult>
export type Fs = typeof import('node:fs/promises')

export interface SandboxEnv {
  exec: Exec
  fs: Fs
  image: string
  /** `${uid}:${gid}`; never root. */
  user: string
  runDir: string
  timeoutMs: number
}

/** A throwaway copy of one app dir: `runDir/sandbox/<name>/<app>/`. */
export interface Sandbox {
  name: string
  app: App
  /** Contains `<app>/`, so repo-relative paths resolve against it. */
  root: string
  appDir: string
}

const STEP_NAME = /^[a-z0-9][a-z0-9-]*$/

/** Copies `sourceAppDir` into a fresh sandbox (ruling R5: every container run gets its own copy). */
export async function createSandbox(
  env: SandboxEnv,
  name: string,
  app: App,
  sourceAppDir: string,
): Promise<Sandbox> {
  if (!STEP_NAME.test(name)) throw new Error(`invalid step name: ${name}`)
  const root = path.join(env.runDir, 'sandbox', name)
  const appDir = path.join(root, app)
  await env.fs.rm(root, { recursive: true, force: true })
  await env.fs.mkdir(root, { recursive: true })
  await env.fs.cp(sourceAppDir, appDir, {
    recursive: true,
    verbatimSymlinks: true,
    // Copy-on-write clone where the filesystem supports it, plain copy otherwise.
    mode: constants.COPYFILE_FICLONE,
  })
  return { name, app, root, appDir }
}

const LOG_LIMIT = 1_000_000

/**
 * Container output for diagnosis, in `runDir/logs/<name>.log`. Never inside the results dir:
 * the container could have planted a symlink there that this write would follow.
 */
export async function writeLog(
  env: Pick<SandboxEnv, 'fs' | 'runDir'>,
  name: string,
  result: ExecResult,
): Promise<void> {
  if (!STEP_NAME.test(name)) throw new Error(`invalid step name: ${name}`)
  const dir = path.join(env.runDir, 'logs')
  await env.fs.mkdir(dir, { recursive: true })
  const status = result.timedOut ? 'timed out' : `exit ${result.code}`
  await env.fs.writeFile(
    path.join(dir, `${name}.log`),
    `${status}\n--- stdout\n${result.stdout.slice(0, LOG_LIMIT)}\n--- stderr\n${result.stderr.slice(0, LOG_LIMIT)}\n`,
  )
}

export interface StepRun {
  name: string
  result: ExecResult
  resultsDir: string
}

/** Runs one container on the sandbox (results in `runDir/results/<name>`), then deletes the sandbox. */
export async function runInSandbox(
  env: SandboxEnv,
  sb: Sandbox,
  opts: {
    command: string[]
    network?: 'none' | 'default'
    env?: Record<string, string>
  },
): Promise<StepRun> {
  const resultsDir = path.join(env.runDir, 'results', sb.name)
  try {
    await env.fs.rm(resultsDir, { recursive: true, force: true })
    await env.fs.mkdir(resultsDir, { recursive: true })
    const result = await runContainer(
      {
        image: env.image,
        appDir: sb.appDir,
        resultsDir,
        command: opts.command,
        env: opts.env,
        network: opts.network ?? 'none',
        name: `test-agent-verify-${randomBytes(4).toString('hex')}-${sb.name}`,
        timeoutMs: env.timeoutMs,
        user: env.user,
      },
      { exec: env.exec },
    )
    await writeLog(env, sb.name, result)
    return { name: sb.name, result, resultsDir }
  } finally {
    await env.fs.rm(sb.root, { recursive: true, force: true })
  }
}

export async function runStep(
  env: SandboxEnv,
  name: string,
  app: App,
  sourceAppDir: string,
  opts: Parameters<typeof runInSandbox>[2],
): Promise<StepRun> {
  return runInSandbox(
    env,
    await createSandbox(env, name, app, sourceAppDir),
    opts,
  )
}
