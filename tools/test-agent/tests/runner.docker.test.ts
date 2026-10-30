import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const image = process.env.TEST_AGENT_IMAGE ?? 'node:22'
const dockerAvailable =
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
const repoRoot = path.resolve(import.meta.dirname, '../../..')
const trustedDir = path.resolve(import.meta.dirname, '../../..')
const binary = path.resolve(import.meta.dirname, '../bin/test-agent-run')

interface Report {
  numFailedTests: number
  numPassedTests: number
  numTotalTests: number
  testResults: {
    name: string
    status: string
    message?: string
    assertionResults: { status: string; failureMessages: string[] }[]
  }[]
}

describe.skipIf(!dockerAvailable)('sandboxed runner (docker)', () => {
  let work = ''

  function runner(app: string, files: string[]) {
    const result = spawnSync(binary, [app, ...files], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TEST_AGENT_WORK_DIR: work,
        TEST_AGENT_TRUSTED_DIR: trustedDir,
        TEST_AGENT_IMAGE: image,
        ANTHROPIC_API_KEY: 'sk-host-secret',
      },
    })
    return { ...result, report: parseReport(result.stdout) }
  }

  function parseReport(stdout: string): Report | null {
    try {
      return JSON.parse(stdout) as Report
    } catch {
      return null
    }
  }

  // Emulates the Linux CI runner: install inside a node:22 container, scripts disabled.
  function install(app: string) {
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${path.join(work, app)}:/app`,
        '-w',
        '/app',
        image,
        'npm',
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { encoding: 'utf8' },
    )
    expect(result.status, result.stderr).toBe(0)
  }

  beforeAll(() => {
    work = realpathSync(mkdtempSync(path.join(tmpdir(), 'runner-docker-')))
    for (const app of ['backend', 'frontend']) {
      cpSync(path.join(repoRoot, app), path.join(work, app), {
        recursive: true,
        filter: (src) => !src.split(path.sep).includes('node_modules'),
      })
      install(app)
    }
    writeFileSync(
      path.join(work, 'backend/tests/net.test.ts'),
      `import { expect, it } from 'vitest'
it('has no network', async () => {
  await fetch('https://example.com')
  expect(true).toBe(true)
})
`,
    )
    writeFileSync(
      path.join(work, 'backend/tests/env.test.ts'),
      `import { expect, it } from 'vitest'
it('sees no host secret', () => {
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(process.env.CI).toBe('1')
})
`,
    )
  }, 600_000)

  afterAll(() => {
    if (work !== '') rmSync(work, { recursive: true, force: true })
  })

  it('installed the native binaries for the container platform despite --ignore-scripts', () => {
    const has = (app: string, dir: string, prefix: string) =>
      readdirSync(path.join(work, app, 'node_modules', dir)).some((name) =>
        name.startsWith(prefix),
      )
    expect(has('backend', '@esbuild', 'linux-')).toBe(true)
    expect(has('backend', '@rolldown', 'binding-linux-')).toBe(true)
    expect(has('backend', '.', 'lightningcss-linux-')).toBe(true)
    expect(has('frontend', '@esbuild', 'linux-')).toBe(true)
    expect(has('frontend', '@rollup', 'rollup-linux-')).toBe(true)
  })

  it('does not leave root-owned files in the workspace', () => {
    expect(statSync(path.join(work, 'backend/node_modules')).uid).toBe(
      process.getuid?.(),
    )
  })

  it('runs backend tests with natively installed (ignore-scripts) binaries', () => {
    const { report, stderr } = runner('backend', ['tests/validators.test.ts'])
    expect(report, stderr).not.toBeNull()
    expect(report?.numFailedTests).toBe(0)
    expect(report?.numPassedTests).toBeGreaterThan(0)
  }, 180_000)

  it('runs a frontend component test (jsdom, react plugin, rolldown)', () => {
    const { report, stderr } = runner('frontend', [
      'src/components/SuccessNotice.test.tsx',
    ])
    expect(report, stderr).not.toBeNull()
    expect(report?.numFailedTests).toBe(0)
    expect(report?.numPassedTests).toBeGreaterThan(0)
  }, 180_000)

  it('has no network inside the container', () => {
    const { report } = runner('backend', ['tests/net.test.ts'])
    expect(report?.numFailedTests).toBe(1)
    const message = (
      report?.testResults[0]?.assertionResults[0]?.failureMessages ?? []
    ).join('\n')
    expect(message).toMatch(/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/)
  }, 180_000)

  it('does not leak host env into the container', () => {
    const { report } = runner('backend', ['tests/env.test.ts'])
    expect(report?.numFailedTests).toBe(0)
    expect(report?.numPassedTests).toBe(1)
  }, 180_000)

  it('rejects bad arguments before invoking docker', () => {
    const result = runner('backend', ['--config=x'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('runner failure')
  })

  it('left no stray files in the app dir', () => {
    expect(readdirSync(path.join(work, 'backend'))).not.toContain('results')
  })
})
