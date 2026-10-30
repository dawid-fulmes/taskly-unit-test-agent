import { describe, expect, it } from 'vitest'
import { loadPolicy } from '../src/policy.ts'
import { dockerArgv, parseRunnerArgs, vitestCommand } from '../src/runner.ts'
import { decide, realpathLoose } from '../src/guard.ts'

const policy = loadPolicy()

describe('parseRunnerArgs', () => {
  it('accepts an app and test files', () => {
    expect(parseRunnerArgs(['backend', 'tests/a.test.ts'], policy)).toEqual({
      app: 'backend',
      files: ['tests/a.test.ts'],
    })
    expect(
      parseRunnerArgs(
        ['frontend', 'src/a.test.tsx', 'src/__evidence__/b.test.ts'],
        policy,
      ),
    ).toEqual({
      app: 'frontend',
      files: ['src/a.test.tsx', 'src/__evidence__/b.test.ts'],
    })
  })

  it.each([
    [['backend', '--config=x']],
    [['backend', '--root']],
    [['backend', 'src/x.ts']],
    [['backend', 'tests/a.test.ts;rm']],
    [['backend', 'tests/a.test.ts|cat']],
    [['backend', 'tests/a.test.ts`id`']],
    [['backend', 'tests/$(id).test.ts']],
    [['backend', 'tests/a.test.ts>x']],
    [['backend', 'tests/a.test.ts\nrm']],
    [['backend', 'tests/a b.test.ts']],
    [['backend', '../frontend/src/a.test.ts']],
    [['backend', '/etc/passwd']],
    [['backend', './tests/a.test.ts']],
    [['backend', 'tests//a.test.ts']],
    [['backend']],
    [['db', 'x']],
    [['db', 'tests/a.test.ts']],
    [[]],
  ])('rejects %j', (argv) => {
    expect(() => parseRunnerArgs(argv, policy)).toThrow()
  })

  it('accepts exactly what the guard accepts', () => {
    const samples = [
      'tests/a.test.ts',
      'tests/sub/a.test.ts',
      'src/a.test.tsx',
      'src/a.test.ts',
      'tests/__evidence__/a.test.ts',
      'src/__evidence__/a.test.tsx',
      'src/a.ts',
      'tests/a.test.js',
      '--config=x',
      '../x.test.ts',
      'tests/./a.test.ts',
      'tests/a;b.test.ts',
      '/tests/a.test.ts',
      'tests/a.test.ts/',
      '',
    ]
    for (const app of ['backend', 'frontend']) {
      for (const file of samples) {
        const guard = decide(
          {
            tool_name: 'Bash',
            tool_input: { command: `test-agent-run ${app} ${file}` },
          },
          { policy, workDir: '/tmp', runDir: '/tmp', realpath: realpathLoose },
        ).allow
        let parsed = true
        try {
          parseRunnerArgs([app, file], policy)
        } catch {
          parsed = false
        }
        expect({ app, file, parsed }).toEqual({ app, file, parsed: guard })
      }
    }
  })
})

describe('dockerArgv', () => {
  const run = {
    image: 'node:22',
    appDir: '/work/backend',
    resultsDir: '/tmp/results',
    command: ['npx', 'vitest', 'run'],
    network: 'none' as const,
  }

  it('never passes host env, even when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret-value'
    try {
      const argv = dockerArgv(run)
      expect(argv.join(' ')).not.toContain('ANTHROPIC_API_KEY')
      expect(argv.join(' ')).not.toContain('sk-secret-value')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('builds the exact argv', () => {
    expect(dockerArgv(run)).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '--env-file',
      '/dev/null',
      '-e',
      'TZ=UTC',
      '-e',
      'HOME=/tmp',
      '-e',
      'CI=1',
      '-v',
      '/work/backend:/app',
      '-v',
      '/tmp/results:/results',
      '-w',
      '/app',
      'node:22',
      'npx',
      'vitest',
      'run',
    ])
  })

  it('applies a TZ override and extra env', () => {
    const argv = dockerArgv({ ...run, env: { TZ: 'Asia/Kolkata', FOO: 'bar' } })
    expect(argv).toContain('TZ=Asia/Kolkata')
    expect(argv).not.toContain('TZ=UTC')
    expect(argv).toContain('FOO=bar')
  })

  it('supports the default network', () => {
    const argv = dockerArgv({ ...run, network: 'default' })
    expect(argv.slice(0, 4)).toEqual(['run', '--rm', '--network', 'default'])
  })
})

describe('vitestCommand', () => {
  it('builds the base command', () => {
    expect(
      vitestCommand({ files: ['tests/a.test.ts'], outputName: 'before' }),
    ).toEqual([
      'npx',
      'vitest',
      'run',
      '--reporter=json',
      '--outputFile=/results/before.json',
      'tests/a.test.ts',
    ])
  })

  it('adds coverage flags', () => {
    const cmd = vitestCommand({ coverage: true, outputName: 'after' })
    expect(cmd).toContain('--coverage.enabled=true')
    expect(cmd).toContain('--coverage.reporter=json')
    expect(cmd).toContain('--coverage.reportsDirectory=/results/after-coverage')
  })

  it('adds shuffle flags', () => {
    const cmd = vitestCommand({ shuffle: true, seed: 2, outputName: 'x' })
    expect(cmd).toContain('--sequence.shuffle=true')
    expect(cmd).toContain('--sequence.seed=2')
  })
})
