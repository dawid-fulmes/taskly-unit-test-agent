import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import picomatch from 'picomatch'
import {
  isEvidencePath,
  isSecretPath,
  isTestPath,
  type Policy,
} from './policy.ts'

export interface GuardContext {
  policy: Policy
  workDir: string
  runDir: string
  realpath: (p: string) => string
}

export interface HookInput {
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id?: string
}

export interface Decision {
  allow: boolean
  reason: string
}

const allow = (reason: string): Decision => ({ allow: true, reason })
const deny = (reason: string): Decision => ({ allow: false, reason })

const BASH_PATTERN = /^test-agent-run (backend|frontend)( [A-Za-z0-9_./@-]+)+$/

/**
 * Resolves symlinks of the longest existing prefix of `p` and re-appends the
 * not-yet-existing remainder, so brand-new files are resolved safely too.
 */
export function realpathLoose(p: string): string {
  const resolved = path.resolve(p)
  const missing: string[] = []
  let current = resolved
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse())
    } catch {
      // realpath also fails for dangling symlinks: only a true ENOENT on lstat
      // means "does not exist yet"; anything else (a symlink, EACCES, ELOOP...) is refused.
      try {
        lstatSync(current)
        throw new Error(`unresolvable path component: ${current}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const parent = path.dirname(current)
      if (parent === current) throw new Error(`cannot resolve ${p}`)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/** Relative path of `target` under `root`, or null when it is outside. */
function relativeInside(root: string, target: string): string | null {
  const rel = path.relative(root, target)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    return null
  return rel.split(path.sep).join('/')
}

function hasDotDot(value: string): boolean {
  return value.split(/[\\/]/).includes('..')
}

const SECRET_SAMPLES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.test',
  '.env.development',
  '.env.prod',
  'backend/.env',
  'backend/.env.production',
  'frontend/.env.local',
  'a/b/.env.test',
]
const GIT_SAMPLES = ['.git', '.git/config', '.git/HEAD', 'a/.git/config']

/** Splits like Claude Code's Grep: on whitespace, then on commas outside braces. */
function splitGlobs(value: string): string[] {
  const pieces: string[] = []
  for (const chunk of value.split(/\s+/)) {
    let depth = 0
    let current = ''
    for (const ch of chunk) {
      if (ch === '{') depth++
      if (ch === '}') depth = Math.max(0, depth - 1)
      if (ch === ',' && depth === 0) {
        pieces.push(current)
        current = ''
      } else {
        current += ch
      }
    }
    pieces.push(current)
  }
  return pieces.filter((piece) => piece !== '')
}

function pieceProblem(policy: Policy, piece: string): string | null {
  if (path.isAbsolute(piece) || piece.startsWith('~')) return 'absolute pattern'
  if (piece.includes('..')) return 'pattern contains ..'
  if (piece.includes('.git')) return 'pattern references .git'
  if (piece.includes('.env') && piece !== '.env.example')
    return 'pattern references .env'
  const secrets = SECRET_SAMPLES.filter((sample) =>
    isSecretPath(policy, sample),
  )
  const candidates = piece.includes('/') ? [piece] : [piece, `**/${piece}`]
  for (const candidate of candidates) {
    for (const sample of [...GIT_SAMPLES, ...secrets]) {
      if (picomatch.isMatch(sample, candidate, { dot: true })) {
        return `pattern can match protected path ${sample}`
      }
    }
  }
  if (isSecretPath(policy, piece)) return 'pattern is a secret path'
  return null
}

/** Patterns must stay inside the work dir and must not be able to reach .git or secrets. */
function patternProblem(policy: Policy, pattern: string): string | null {
  if (pattern.trim() === '') return 'empty pattern'
  for (const piece of [pattern, ...splitGlobs(pattern)]) {
    const problem = pieceProblem(policy, piece)
    if (problem !== null) return problem
  }
  return null
}

function resolveTarget(ctx: GuardContext, raw: unknown): string | Decision {
  if (typeof raw !== 'string' || raw === '')
    return deny('missing or invalid path')
  if (raw.startsWith('~') || raw.includes('\0'))
    return deny('unsupported path form')
  try {
    return ctx.realpath(path.resolve(ctx.realpath(ctx.workDir), raw))
  } catch {
    return deny('path cannot be safely resolved')
  }
}

function decideRead(
  tool: string,
  input: Record<string, unknown>,
  ctx: GuardContext,
): Decision {
  const workDir = ctx.realpath(ctx.workDir)
  const runDir = ctx.realpath(ctx.runDir)
  const rawPath = tool === 'Read' ? input.file_path : (input.path ?? workDir)
  const pattern =
    tool === 'Glob' ? input.pattern : tool === 'Grep' ? input.glob : undefined
  if (tool === 'Glob' && typeof pattern !== 'string')
    return deny('missing glob pattern')
  if (typeof pattern === 'string') {
    const problem = patternProblem(ctx.policy, pattern)
    if (problem !== null) return deny(problem)
  }
  const target = resolveTarget(ctx, rawPath)
  if (typeof target !== 'string') return target
  const inWork = relativeInside(workDir, target)
  const inRun = relativeInside(runDir, target)
  const rel = inWork ?? inRun
  if (rel === null) return deny('path outside work and run dirs')
  if (rel.split('/').includes('.git')) return deny('.git is not readable')
  if (isSecretPath(ctx.policy, rel)) return deny('secret path')
  return allow('read within work or run dir')
}

function decideWrite(
  input: Record<string, unknown>,
  ctx: GuardContext,
): Decision {
  const target = resolveTarget(ctx, input.file_path)
  if (typeof target !== 'string') return target
  if (target === path.join(ctx.realpath(ctx.runDir), 'report.json')) {
    return allow('run report')
  }
  const rel = relativeInside(ctx.realpath(ctx.workDir), target)
  if (rel === null || rel === '') return deny('path outside work dir')
  if (isTestPath(ctx.policy, rel) || isEvidencePath(ctx.policy, rel)) {
    return allow('test or evidence file')
  }
  return deny('only test or evidence files may be written')
}

function decideBash(
  input: Record<string, unknown>,
  ctx: GuardContext,
): Decision {
  const command = input.command
  if (typeof command !== 'string' || !BASH_PATTERN.test(command)) {
    return deny('only `test-agent-run <app> <files...>` is allowed')
  }
  const [, app, ...files] = command.split(' ')
  for (const file of files) {
    if (file.startsWith('-')) return deny(`option argument rejected: ${file}`)
    if (path.posix.isAbsolute(file) || hasDotDot(file)) {
      return deny(`path escapes the app dir: ${file}`)
    }
    if (path.posix.normalize(file) !== file)
      return deny(`non-canonical path: ${file}`)
    const repoPath = `${app}/${file}`
    if (
      !isTestPath(ctx.policy, repoPath) &&
      !isEvidencePath(ctx.policy, repoPath)
    ) {
      return deny(`not a test or evidence file: ${file}`)
    }
  }
  return allow('test-agent-run on test files')
}

export function decide(input: HookInput, ctx: GuardContext): Decision {
  const toolInput =
    input.tool_input !== null && typeof input.tool_input === 'object'
      ? input.tool_input
      : null
  if (toolInput === null) return deny('invalid tool_input')
  switch (input.tool_name) {
    case 'Read':
    case 'Grep':
    case 'Glob':
      return decideRead(input.tool_name, toolInput, ctx)
    case 'Write':
    case 'Edit':
      return decideWrite(toolInput, ctx)
    case 'Bash':
      return decideBash(toolInput, ctx)
    case 'Skill':
      return allow('skills are allowed')
    default:
      return deny(`tool not allowed: ${String(input.tool_name)}`)
  }
}
