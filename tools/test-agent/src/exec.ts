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
}

/** Runs a command without a shell. Never rejects on a non-zero exit; spawn failures yield code 127. */
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
      timeout: opts.timeoutMs,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      resolve({ code: 127, stdout, stderr: stderr + error.message })
    })
    child.on('close', (code, signal) => {
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr })
    })
    child.stdin.end(opts.input ?? '')
  })
}
