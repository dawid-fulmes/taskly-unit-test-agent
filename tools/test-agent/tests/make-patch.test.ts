import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/cli/make-patch.ts',
)
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'patch-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
  mkdirSync(path.join(dir, 'backend/tests'), { recursive: true })
  writeFileSync(
    path.join(dir, 'backend/tests/a.test.ts'),
    "it('a', () => {})\n",
  )
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return { dir, head: git(dir, 'rev-parse', 'HEAD') }
}

describe('make-patch', () => {
  it('captures new and modified files against head, with a matching sha256', () => {
    const { dir, head } = repo()
    writeFileSync(
      path.join(dir, 'backend/tests/a.test.ts'),
      "it('a', () => {})\nit('b', () => {})\n",
    )
    writeFileSync(
      path.join(dir, 'backend/tests/new.test.ts'),
      "it('n', () => {})\n",
    )
    const out = path.join(dir, '..', `${path.basename(dir)}.diff`)
    const r = spawnSync(
      process.execPath,
      [cli, '--work', dir, '--head', head, '--out', out],
      {
        encoding: 'utf8',
      },
    )
    expect(r.status).toBe(0)
    const patch = readFileSync(out, 'utf8')
    expect(patch).toContain(
      'diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts',
    )
    expect(patch).toContain(
      'diff --git a/backend/tests/new.test.ts b/backend/tests/new.test.ts',
    )
    expect(patch).toContain("+it('b', () => {})")
    const sha = createHash('sha256').update(patch).digest('hex')
    expect(readFileSync(`${out}.sha256`, 'utf8').trim()).toBe(sha)
  })

  it('drops empty new files (abandoned by the agent) from the patch', () => {
    const { dir, head } = repo()
    writeFileSync(path.join(dir, 'backend/tests/abandoned.test.ts'), '')
    writeFileSync(
      path.join(dir, 'backend/tests/kept.test.ts'),
      "it('k', () => {})\n",
    )
    const out = path.join(dir, '..', `${path.basename(dir)}-e.diff`)
    const r = spawnSync(
      process.execPath,
      [cli, '--work', dir, '--head', head, '--out', out],
      {
        encoding: 'utf8',
      },
    )
    expect(r.status).toBe(0)
    const patch = readFileSync(out, 'utf8')
    expect(patch).not.toContain('abandoned.test.ts')
    expect(patch).toContain('kept.test.ts')
  })

  it('restores .claude and instruction files to head so workspace preparation never enters the patch', () => {
    const { dir } = repo()
    mkdirSync(path.join(dir, '.claude/agents'), { recursive: true })
    writeFileSync(
      path.join(dir, '.claude/agents/unit-test-agent.md'),
      'head agent\n',
    )
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'head instructions\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'head with agent config')
    const head = git(dir, 'rev-parse', 'HEAD')
    // What prepare-workspace does: trusted .claude replaces head's, instruction files removed.
    writeFileSync(
      path.join(dir, '.claude/agents/unit-test-agent.md'),
      'trusted agent\n',
    )
    mkdirSync(path.join(dir, '.claude/skills/x'), { recursive: true })
    writeFileSync(
      path.join(dir, '.claude/skills/x/SKILL.md'),
      'trusted skill\n',
    )
    rmSync(path.join(dir, 'CLAUDE.md'))
    writeFileSync(
      path.join(dir, 'backend/tests/new.test.ts'),
      "it('n', () => {})\n",
    )
    const out = path.join(dir, '..', `${path.basename(dir)}-c.diff`)
    const r = spawnSync(
      process.execPath,
      [cli, '--work', dir, '--head', head, '--out', out],
      {
        encoding: 'utf8',
      },
    )
    expect(r.status).toBe(0)
    const patch = readFileSync(out, 'utf8')
    expect(patch).not.toContain('.claude/')
    expect(patch).not.toContain('CLAUDE.md')
    expect(patch).toContain('backend/tests/new.test.ts')
  })

  it('restores nested .claude directories tracked by head', () => {
    const { dir } = repo()
    mkdirSync(path.join(dir, 'backend/.claude/skills/x'), { recursive: true })
    writeFileSync(
      path.join(dir, 'backend/.claude/skills/x/SKILL.md'),
      'head skill\n',
    )
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'nested agent config')
    const head = git(dir, 'rev-parse', 'HEAD')
    rmSync(path.join(dir, 'backend/.claude'), { recursive: true }) // what prepare-workspace does
    const out = path.join(dir, '..', `${path.basename(dir)}-n.diff`)
    const r = spawnSync(
      process.execPath,
      [cli, '--work', dir, '--head', head, '--out', out],
      {
        encoding: 'utf8',
      },
    )
    expect(r.status).toBe(0)
    expect(readFileSync(out, 'utf8')).not.toContain('.claude/')
  })

  it('drops an untracked .claude directory that head does not have', () => {
    const { dir, head } = repo()
    mkdirSync(path.join(dir, '.claude/agents'), { recursive: true })
    writeFileSync(
      path.join(dir, '.claude/agents/unit-test-agent.md'),
      'trusted agent\n',
    )
    const out = path.join(dir, '..', `${path.basename(dir)}-u.diff`)
    const r = spawnSync(
      process.execPath,
      [cli, '--work', dir, '--head', head, '--out', out],
      {
        encoding: 'utf8',
      },
    )
    expect(r.status).toBe(0)
    expect(readFileSync(out, 'utf8')).not.toContain('.claude/')
  })

  it('fails closed when HEAD is not the analysed head', () => {
    const { dir } = repo()
    const out = path.join(dir, '..', `${path.basename(dir)}-x.diff`)
    const r = spawnSync(
      process.execPath,
      [cli, '--work', dir, '--head', 'f'.repeat(40), '--out', out],
      { encoding: 'utf8' },
    )
    expect(r.status).not.toBe(0)
  })
})
