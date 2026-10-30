import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

// Replaces the PR head's agent configuration with the trusted (base) copy and removes every
// instruction or MCP file the head ships, so nothing PR-controlled is loaded by Claude Code.
// Fail closed: any problem exits non-zero and the pipeline does not start the agent.
// Removed at any depth, together with every .claude directory (the trusted copy goes in afterwards).
const INSTRUCTION_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'])
const SKIP_DIRS = new Set(['.git', 'node_modules'])

function removeInstructionFiles(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    // Nested .claude directories can carry skills or settings Claude Code picks up for files in
    // that subtree; only the trusted root copy may exist.
    if (INSTRUCTION_FILES.has(entry.name) || entry.name === '.claude') {
      rmSync(full, { recursive: true, force: true })
      continue
    }
    if (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      !SKIP_DIRS.has(entry.name)
    )
      removeInstructionFiles(full)
  }
}

try {
  const { values } = parseArgs({
    options: { trusted: { type: 'string' }, work: { type: 'string' } },
    strict: true,
  })
  if (!values.trusted || !values.work)
    throw new Error('usage: --trusted <dir> --work <dir>')
  const trusted = realpathSync(values.trusted)
  const work = realpathSync(values.work)
  if (trusted === work) throw new Error('--trusted and --work must differ')
  const source = path.join(trusted, '.claude')
  if (!existsSync(source) || !lstatSync(source).isDirectory())
    throw new Error(`no trusted .claude directory in ${trusted}`)

  removeInstructionFiles(work)
  cpSync(source, path.join(work, '.claude'), {
    recursive: true,
    verbatimSymlinks: true,
  })
} catch (error) {
  process.stderr.write(
    `prepare-workspace failed: ${(error as Error).message}\n`,
  )
  process.exitCode = 1
}
