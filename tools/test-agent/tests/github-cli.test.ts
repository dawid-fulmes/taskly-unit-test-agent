import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exec } from '../src/exec.ts'

// Network-free smoke tests: every case here is decided before any GitHub call.
const CLI = (name: string) => join(import.meta.dirname, `../src/cli/${name}.ts`)
const SECRET = 'ghs_doNotPrintThisToken0123456789'
const BASE_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GITHUB_REPOSITORY: 'acme/taskly',
  GITHUB_RUN_ID: '123',
  TEST_AGENT_BOT_LOGIN: 'taskly-test-agent[bot]',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'github-cli-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (name: string, args: string[], env: Record<string, string>) =>
  exec(process.execPath, [CLI(name), ...args], {
    cwd: dir,
    env: { ...BASE_ENV, ...env },
    timeoutMs: 30_000,
  })

describe('filter CLI', () => {
  const args = (trigger: string) => [
    '--trigger',
    trigger,
    '--workflow-run-head-sha',
    'a'.repeat(40),
    '--triggering-actor',
    'alice',
    '--out',
    join(dir, 'out.json'),
  ]

  it('stops on an invalid trigger artifact and writes the outputs', async () => {
    const trigger = join(dir, 'trigger.json')
    writeFileSync(
      trigger,
      JSON.stringify({ prNumber: 7, headSha: 'nope', action: 'synchronize' }),
    )
    const outputs = join(dir, 'github_output')
    writeFileSync(outputs, '')
    const r = await run('filter', args(trigger), {
      GITHUB_TOKEN: SECRET,
      GITHUB_OUTPUT: outputs,
    })
    expect(r.code).toBe(0)
    expect(
      JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')),
    ).toMatchObject({ path: 'stop', pr_number: '', head_sha: '' })
    expect(readFileSync(outputs, 'utf8')).toContain('path=stop\n')
    expect(r.stdout + r.stderr).not.toContain(SECRET)
  })

  it('stops on a missing trigger artifact', async () => {
    const r = await run('filter', args(join(dir, 'missing.json')), {
      GITHUB_TOKEN: SECRET,
    })
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).path).toBe(
      'stop',
    )
  })

  it('fails closed without a token', async () => {
    const r = await run('filter', args(join(dir, 'missing.json')), {})
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/GITHUB_TOKEN/)
  })

  it('fails closed on an invalid triggering actor', async () => {
    const a = args(join(dir, 'missing.json'))
    a[5] = 'evil\nactor'
    const r = await run('filter', a, { GITHUB_TOKEN: SECRET })
    expect(r.code).toBe(1)
  })
})

describe('dismiss CLI', () => {
  it('fails closed without the App token', async () => {
    const r = await run('dismiss', ['--pr-number', '7', '--labeler', 'bob'], {
      TEST_AGENT_APP_ID: '42',
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/TEST_AGENT_APP_TOKEN/)
  })

  it('rejects an invalid labeler before any API call', async () => {
    const r = await run(
      'dismiss',
      ['--pr-number', '7', '--labeler', 'bob; rm -rf /'],
      { TEST_AGENT_APP_TOKEN: SECRET, TEST_AGENT_APP_ID: '42' },
    )
    expect(r.code).toBe(1)
    expect(r.stdout + r.stderr).not.toContain(SECRET)
  })
})

describe('publish CLI', () => {
  it('fails closed without the App token', async () => {
    const r = await run(
      'publish',
      ['--run-id', '1', '--work', dir, '--plan', join(dir, 'plan.json')],
      {},
    )
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/TEST_AGENT_APP_TOKEN/)
  })

  it('fails when neither a plan nor the fallback PR inputs exist', async () => {
    const r = await run(
      'publish',
      ['--run-id', '1', '--work', dir, '--plan', join(dir, 'plan.json')],
      {
        TEST_AGENT_APP_TOKEN: SECRET,
        TEST_AGENT_BOT_NAME: 'taskly-test-agent[bot]',
        TEST_AGENT_BOT_EMAIL:
          '1+taskly-test-agent[bot]@users.noreply.github.com',
      },
    )
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/plan\.json/)
    expect(r.stdout + r.stderr).not.toContain(SECRET)
  })
})
