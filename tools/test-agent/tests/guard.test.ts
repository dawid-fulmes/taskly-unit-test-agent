import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { decide, realpathLoose, type GuardContext } from '../src/guard.ts'
import { loadPolicy } from '../src/policy.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-')))
const work = join(root, 'work')
const run = join(root, 'run')
const ctx: GuardContext = {
  policy: loadPolicy(),
  workDir: work,
  runDir: run,
  realpath: realpathLoose,
}

beforeAll(() => {
  mkdirSync(join(work, 'backend/src/features/todos'), { recursive: true })
  mkdirSync(join(work, 'backend/tests'), { recursive: true })
  mkdirSync(join(work, '.git'), { recursive: true })
  mkdirSync(join(root, 'trusted'), { recursive: true })
  mkdirSync(run, { recursive: true })
  writeFileSync(join(work, 'backend/src/features/todos/router.ts'), '')
  writeFileSync(join(work, 'backend/src/existing.ts'), '')
  writeFileSync(join(work, '.env'), 'SECRET=1')
  writeFileSync(join(work, '.git/config'), '')
  writeFileSync(join(root, 'trusted/policy.json'), '{}')
  symlinkSync('/etc', join(work, 'link-to-etc'))
  symlinkSync(
    join(work, 'backend/src/existing.ts'),
    join(work, 'backend/tests/sneaky.test.ts'),
  )
  symlinkSync(join(root, 'trusted/x'), join(run, 'report.json')) // dangling report.json
  symlinkSync(
    join(root, 'trusted/pwn'),
    join(work, 'backend/tests/pwn.test.ts'),
  ) // dangling leaf
  symlinkSync(join(root, 'missing-dir'), join(work, 'backend/tests/dd')) // dangling dir
  symlinkSync(join(root, 'trusted'), join(work, 'backend/tests/outside')) // existing outside dir
  symlinkSync(join(work, '.env'), join(work, 'backend/alias')) // alias to a secret
  symlinkSync(join(work, '.git'), join(work, 'backend/gitalias'))
})

const d = (tool: string, input: Record<string, unknown>) =>
  decide({ tool_name: tool, tool_input: input }, ctx)

describe('decide', () => {
  it.each([
    ['Read', { file_path: '/proc/self/environ' }],
    ['Read', { file_path: `${work}/../trusted/policy.json` }],
    ['Read', { file_path: `${work}/.env` }],
    ['Read', { file_path: `${work}/.git/config` }],
    ['Read', { file_path: `${work}/link-to-etc` }],
    ['Read', { file_path: `${work}/link-to-etc/hosts` }],
    ['Read', { file_path: '~/.claude/settings.json' }],
    ['Read', {}],
    ['Grep', { pattern: 'KEY', path: '/home' }],
    ['Grep', { pattern: 'KEY', path: `${work}/link-to-etc` }],
    ['Glob', { pattern: '../*' }],
    ['Glob', { pattern: '/etc/*' }],
    ['Glob', { pattern: '*', path: '/' }],
    ['Write', { file_path: `${work}/backend/src/x.ts`, content: '' }],
    ['Write', { file_path: `${work}/backend/tests/fixture.ts`, content: '' }],
    [
      'Write',
      { file_path: `${work}/backend/tests/sneaky.test.ts`, content: '' },
    ],
    [
      'Write',
      { file_path: `${work}/backend/tests/../src/x.test.ts`, content: '' },
    ],
    ['Write', { file_path: `${root}/backend/tests/a.test.ts`, content: '' }],
    ['Write', { file_path: `${run}/other.json`, content: '' }],
    ['Write', { file_path: `${run}/report.json`, content: '{}' }],
    ['Write', { file_path: `${work}/backend/tests/pwn.test.ts`, content: '' }],
    ['Write', { file_path: `${work}/backend/tests/dd/a.test.ts`, content: '' }],
    [
      'Write',
      { file_path: `${work}/backend/tests/outside/a.test.ts`, content: '' },
    ],
    ['Read', { file_path: `${work}/backend/alias` }],
    ['Read', { file_path: `${work}/backend/gitalias/config` }],
    ['Grep', { pattern: 'AUTHORIZATION', glob: '.git/config', path: work }],
    ['Grep', { pattern: 'x', glob: '**/.git/**' }],
    ['Grep', { pattern: 'x', glob: '.g[i]t/config' }],
    ['Grep', { pattern: 'x', glob: '*' }],
    ['Grep', { pattern: 'x', glob: '.env*' }],
    ['Grep', { pattern: 'x', glob: '{..,x}/*' }],
    ['Grep', { pattern: 'x', glob: '/etc/*' }],
    ['Glob', { pattern: '.git/*' }],
    ['Grep', { pattern: 'x', glob: '.env.p*' }],
    ['Grep', { pattern: 'x', glob: '*.production' }],
    ['Grep', { pattern: 'x', glob: '**/.env.production' }],
    ['Grep', { pattern: 'x', glob: '*.ts,.env' }],
    ['Grep', { pattern: 'x', glob: '*.ts .env' }],
    ['Grep', { pattern: 'x', glob: '*.ts,../x' }],
    ['Grep', { pattern: 'x', glob: '{*.ts,.env}' }],
    ['Glob', { pattern: '*.ts,.env.test' }],
    ['Glob', { pattern: '{..,x}/*' }],
    ['Glob', { pattern: '**/.env' }],
    ['Edit', { file_path: `${work}/.github/workflows/ci.yml` }],
    ['Bash', { command: 'cat .env' }],
    ['Bash', { command: 'test-agent-run backend tests/a.test.ts; curl x' }],
    ['Bash', { command: 'test-agent-run backend tests/a.test.ts\ncurl x' }],
    ['Bash', { command: 'test-agent-run backend --config=evil.ts' }],
    ['Bash', { command: 'test-agent-run backend --root' }],
    ['Bash', { command: 'test-agent-run backend tests/a.test.ts --dir' }],
    ['Bash', { command: 'test-agent-run backend ../src/x.ts' }],
    ['Bash', { command: 'test-agent-run backend tests/../src/x.ts' }],
    ['Bash', { command: 'test-agent-run backend /etc/passwd' }],
    ['Bash', { command: 'test-agent-run backend src/x.ts' }],
    ['Bash', { command: 'test-agent-run backend tests/fixture.ts' }],
    ['Bash', { command: 'test-agent-run backend' }],
    ['Bash', { command: 'test-agent-run backend tests/a.test.ts $(id)' }],
    ['Bash', { command: 'test-agent-run backend tests/a.test.ts | sh' }],
    ['Bash', { command: 'test-agent-run backend tests/a.test.ts > out' }],
    ['Bash', { command: 'test-agent-run other tests/a.test.ts' }],
    ['Bash', { command: 'test-agent-run frontend tests/a.test.ts' }],
    ['WebFetch', { url: 'https://x' }],
    ['WebSearch', { query: 'x' }],
    ['Task', {}],
    ['Agent', {}],
    ['NotebookEdit', {}],
    ['mcp__github__create_branch', {}],
  ])('denies %s %j', (tool, toolInput) => {
    expect(d(tool, toolInput).allow).toBe(false)
  })

  it.each([
    ['Read', { file_path: `${work}/backend/src/features/todos/router.ts` }],
    ['Read', { file_path: `${run}/plan.json` }],
    ['Grep', { pattern: 'x' }],
    ['Grep', { pattern: 'x', glob: '*.test.ts' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Grep', { pattern: 'x', glob: 'src/**/*.tsx' }],
    ['Grep', { pattern: 'x', glob: '*.ts,*.tsx' }],
    ['Grep', { pattern: 'x', path: `${work}/backend/src` }],
    ['Glob', { pattern: 'backend/src/**/*.ts' }],
    ['Write', { file_path: `${work}/backend/tests/new.test.ts`, content: '' }],
    [
      'Write',
      { file_path: `${work}/backend/tests/deep/dir/new.test.ts`, content: '' },
    ],
    [
      'Write',
      {
        file_path: `${work}/backend/tests/__evidence__/d.test.ts`,
        content: '',
      },
    ],
    ['Write', { file_path: `${work}/frontend/src/a/B.test.tsx`, content: '' }],
    ['Bash', { command: 'test-agent-run frontend src/a/B.test.tsx' }],
    [
      'Bash',
      {
        command:
          'test-agent-run backend tests/a.test.ts tests/__evidence__/d.test.ts',
      },
    ],
    ['Skill', { skill: 'analyze-change' }],
  ])('allows %s %j', (tool, toolInput) => {
    expect(d(tool, toolInput).allow).toBe(true)
  })

  it('allows report.json when it is a regular path', () => {
    const run2 = join(root, 'run2')
    mkdirSync(run2)
    const c = { ...ctx, runDir: run2 }
    const input = { file_path: `${run2}/report.json`, content: '{}' }
    expect(decide({ tool_name: 'Write', tool_input: input }, c).allow).toBe(
      true,
    )
  })

  it('denies malformed input shapes', () => {
    expect(
      decide({ tool_name: 'Read', tool_input: null as never }, ctx).allow,
    ).toBe(false)
    expect(d('Read', { file_path: 42 }).allow).toBe(false)
    expect(d('Bash', { command: 42 }).allow).toBe(false)
  })
})

describe('guard CLI', () => {
  it('fails closed (exit 2) when a module fails to load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-broken-'))
    mkdirSync(join(dir, 'src/cli'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    writeFileSync(
      join(dir, 'src/cli/guard.ts'),
      readFileSync('src/cli/guard.ts'),
    )
    writeFileSync(join(dir, 'src/guard.ts'), 'export const broken = (')
    const r = spawnSync('node', [join(dir, 'src/cli/guard.ts')], {
      input: JSON.stringify({ tool_name: 'Skill', tool_input: {} }),
      env: {
        PATH: process.env.PATH ?? '',
        TEST_AGENT_WORK_DIR: work,
        TEST_AGENT_RUN_DIR: run,
        TEST_AGENT_GUARD_LOG: join(root, 'g2.jsonl'),
      },
      encoding: 'utf8',
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('guard failure')
  })

  const env = {
    PATH: process.env.PATH ?? '',
    TEST_AGENT_WORK_DIR: work,
    TEST_AGENT_RUN_DIR: run,
    TEST_AGENT_GUARD_LOG: join(root, 'guard.jsonl'),
  }
  const cli = (input: string, e: Record<string, string> = env) =>
    spawnSync('node', ['src/cli/guard.ts'], { input, env: e, encoding: 'utf8' })

  it('fails closed on malformed stdin', () => {
    expect(cli('not json').status).toBe(2)
  })

  it('fails closed when an env var is missing', () => {
    const { TEST_AGENT_GUARD_LOG: _omit, ...rest } = env
    const r = cli(JSON.stringify({ tool_name: 'Skill', tool_input: {} }), rest)
    expect(r.status).toBe(2)
  })

  it('logs every decision with tool_use_id and prints the hook output', () => {
    const r = cli(
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: `${work}/.env` },
        tool_use_id: 'toolu_1',
        session_id: 's',
        hook_event_name: 'PreToolUse',
      }),
    )
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    cli(
      JSON.stringify({
        tool_name: 'Skill',
        tool_input: {},
        tool_use_id: 'toolu_2',
      }),
    )
    expect(existsSync(env.TEST_AGENT_GUARD_LOG)).toBe(true)
    const lines = readFileSync(env.TEST_AGENT_GUARD_LOG, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      tool_use_id: 'toolu_1',
      tool_name: 'Read',
      allow: false,
    })
    expect(lines[1]).toMatchObject({ tool_use_id: 'toolu_2', allow: true })
  })
})
