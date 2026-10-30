import { createHash } from 'node:crypto'
import { lstatSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

// Same set prepare-workspace removes.
const INSTRUCTION_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'])

// Captures everything the agent changed in the work tree as one binary-safe diff against the
// analysed head, plus its sha256. The patch is data: verify and publish gate it later.
// Fail closed: node: built-ins only are imported statically; everything else loads inside try.
try {
  const { exec } = await import('../exec.ts')
  const { git } = await import('../verify/git.ts')

  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      head: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  })
  const { work, head, out } = values
  if (!work || !head || !out)
    throw new Error('usage: --work <dir> --head <sha> --out <file>')
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new Error('--head must be a full commit SHA')

  const noHooks = ['-c', 'core.hooksPath=/dev/null']
  if (
    (await git(exec, work, [...noHooks, 'rev-parse', 'HEAD'])).trim() !== head
  )
    throw new Error('work tree HEAD is not the analysed head')
  // Undo prepare-workspace: .claude and instruction files go back to exactly what head has, so
  // the trusted copy never shows up as a change the agent made.
  rmSync(join(work, '.claude'), { recursive: true, force: true })
  const tracked = (
    await git(exec, work, [
      ...noHooks,
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      head,
    ])
  )
    .split('\0')
    .filter(
      (p) =>
        p.startsWith('.claude/') ||
        INSTRUCTION_FILES.has(p.split('/').pop() ?? ''),
    )
  if (tracked.length > 0)
    await git(exec, work, [...noHooks, 'checkout', head, '--', ...tracked])
  // The agent cannot delete files; it abandons a new test file by emptying it. Empty untracked
  // files carry no content, so they are dropped before the diff instead of failing the gates.
  const untracked = await git(exec, work, [
    ...noHooks,
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
  for (const rel of untracked.split('\0').filter(Boolean)) {
    const file = join(work, rel)
    const st = lstatSync(file)
    if (st.isFile() && st.size === 0) unlinkSync(file)
  }
  // Intent-to-add makes new files visible to `git diff` without staging their content.
  await git(exec, work, [...noHooks, 'add', '-A', '-N'])
  const patch = await git(exec, work, [
    ...noHooks,
    'diff',
    '--binary',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    head,
  ])
  writeFileSync(out, patch)
  const sha = createHash('sha256').update(patch).digest('hex')
  writeFileSync(`${out}.sha256`, `${sha}\n`)
} catch (error) {
  process.stderr.write(`make-patch failed: ${(error as Error).message}\n`)
  process.exitCode = 1
}
