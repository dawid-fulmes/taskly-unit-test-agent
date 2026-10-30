import { spawn } from 'node:child_process'

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  input?: string
  timeoutMs?: number
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Runs a command without a shell; on timeout the child is SIGKILLed and `timedOut` is set. Never rejects on a non-zero exit; spawn failures yield code 127. */
export function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let timedOut = false
    const timer =
      opts.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, opts.timeoutMs)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolve({
        code: 127,
        stdout,
        stderr: stderr + error.message,
        timedOut,
      })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout,
        stderr,
        timedOut,
      })
    })
    child.stdin.end(opts.input ?? '')
  })
}
