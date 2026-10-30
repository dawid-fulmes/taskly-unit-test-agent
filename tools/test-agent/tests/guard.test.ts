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
  symlinkSync('/etc/hosts', join(run, 'report.json.link'))
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
    ['Write', { file_path: `${run}/report.json.link`, content: '' }],
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
    ['Write', { file_path: `${run}/report.json`, content: '{}' }],
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

  it('denies malformed input shapes', () => {
    expect(
      decide({ tool_name: 'Read', tool_input: null as never }, ctx).allow,
    ).toBe(false)
    expect(d('Read', { file_path: 42 }).allow).toBe(false)
    expect(d('Bash', { command: 42 }).allow).toBe(false)
  })
})

describe('guard CLI', () => {
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
