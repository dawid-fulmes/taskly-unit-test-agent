import path from 'node:path'
import { isEvidencePath, isTestPath, type Policy } from '../policy.ts'
import type { Exec } from './sandbox.ts'

export interface StatusEntry {
  /** Porcelain v1 XY code (`??`, `!!`, ` M`, `D `, `R `, ...). */
  code: string
  path: string
  /** Rename/copy source. */
  orig: string | null
}

const GIT_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  // Only the repository's own config: no user (~/.gitconfig) or system config.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
})

export async function git(
  exec: Exec,
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const r = await exec('git', args, {
    cwd,
    env: { ...GIT_ENV(), ...extraEnv },
    timeoutMs: 120_000,
  })
  if (r.code !== 0 || r.timedOut)
    throw new Error(
      `git ${args[0]} failed (code ${r.code}): ${r.stderr.trim().slice(0, 300)}`,
    )
  return r.stdout
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parsePorcelainZ(out: string): StatusEntry[] {
  const fields = out.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    if (f.length < 4 || f[2] !== ' ')
      throw new Error(`unparseable status entry: ${JSON.stringify(f)}`)
    const code = f.slice(0, 2)
    const renamed = code[0] === 'R' || code[0] === 'C'
    const orig = renamed ? (fields[++i] ?? null) : null
    if (renamed && orig === null)
      throw new Error('rename status entry without source')
    entries.push({ code, path: f.slice(3), orig })
  }
  return entries
}

/**
 * Every untracked, changed and ignored entry of the work tree. Ignored entries (`matching`)
 * are included so a head `.gitignore` cannot hide a path that `git apply` writes.
 */
export async function statusSnapshot(
  exec: Exec,
  workDir: string,
): Promise<StatusEntry[]> {
  return parsePorcelainZ(
    await git(exec, workDir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
    ]),
  )
}

const key = (e: StatusEntry) => `${e.code}\0${e.path}\0${e.orig ?? ''}`

/**
 * R6: the real changed-file set of `git apply` (status after minus status before) must be
 * test files named by the evidence-stripped patch; no deletions, renames or evidence files.
 */
export function appliedPathsCheck(
  before: StatusEntry[],
  after: StatusEntry[],
  patchPaths: Set<string>,
  policy: Policy,
): { ok: boolean; offending: string[] } {
  const offending = new Set<string>()
  const beforeKeys = new Set(before.map(key))
  const afterKeys = new Set(after.map(key))
  for (const e of after) {
    if (beforeKeys.has(key(e))) continue
    if (e.orig !== null) {
      offending.add(e.orig)
      offending.add(e.path)
      continue
    }
    if (
      e.code.includes('D') ||
      !isTestPath(policy, e.path) ||
      isEvidencePath(policy, e.path) ||
      !patchPaths.has(e.path)
    )
      offending.add(e.path)
  }
  // An entry that vanished means apply removed or reverted something.
  for (const e of before) if (!afterKeys.has(key(e))) offending.add(e.path)
  const list = [...offending].sort()
  return { ok: list.length === 0, offending: list }
}

/**
 * Applies a patch file inside `cwd`. Outside a repository (sandbox copies) git must not
 * discover a repository above `cwd`, so discovery stops at its parent.
 */
export async function gitApply(
  exec: Exec,
  cwd: string,
  patchFile: string,
  opts: { outsideRepo?: boolean } = {},
): Promise<void> {
  await git(
    exec,
    cwd,
    ['apply', '--whitespace=nowarn', patchFile],
    opts.outsideRepo ? { GIT_CEILING_DIRECTORIES: path.dirname(cwd) } : {},
  )
}
