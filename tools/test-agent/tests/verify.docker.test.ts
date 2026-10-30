import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exec } from '../src/exec.ts'
import type { Report } from '../src/report.ts'
import type { Plan } from '../src/types.ts'
import { runVerify } from '../src/verify.ts'
import { addedFileDiff } from './verify-harness.ts'

const image = process.env.TEST_AGENT_IMAGE ?? 'node:22'
const dockerAvailable =
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
const repoRoot = path.resolve(import.meta.dirname, '../../..')

const TEST = 'backend/tests/config.test.ts'
const EVIDENCE = 'backend/tests/__evidence__/config.test.ts'
const QUOTE = 'An explicit database URL override is returned verbatim.'

const TEST_TEXT = `import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDatabaseUrl } from '../src/core/config.ts'

describe('resolveDatabaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('falls back to DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u@h/d')
    expect(resolveDatabaseUrl()).toBe('postgresql://u@h/d')
  })

  it('builds the URL from the individual variables', () => {
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('POSTGRES_USER', 'app')
    vi.stubEnv('POSTGRES_PASSWORD', 'p@ss word')
    vi.stubEnv('POSTGRES_HOST', 'db.internal')
    vi.stubEnv('DB_PORT', '5433')
    vi.stubEnv('POSTGRES_DB', 'taskly')
    expect(resolveDatabaseUrl()).toBe(
      'postgresql://app:p%40ss%20word@db.internal:5433/taskly',
    )
  })

  it('names the first missing variable', () => {
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('POSTGRES_USER', '')
    expect(() => resolveDatabaseUrl()).toThrow(
      'Missing environment variable: POSTGRES_USER',
    )
  })
})
`

// Fails on head by assertion: head rewrites the psycopg scheme.
const EVIDENCE_TEXT = `import { expect, it } from 'vitest'
import { resolveDatabaseUrl } from '../../src/core/config.ts'

it('returns an explicit override verbatim', () => {
  expect(resolveDatabaseUrl('postgresql+psycopg://h/d')).toBe(
    'postgresql+psycopg://h/d',
  )
})
`

describe.skipIf(!dockerAvailable)('verify orchestration (docker)', () => {
  let root = ''
  let work = ''

  const run = (cmd: string, args: string[], cwd?: string) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-docker-')))
    work = path.join(root, 'work')
    // A real checkout of the committed head, like actions/checkout in CI.
    run('git', ['clone', '--quiet', '--no-hardlinks', repoRoot, work])
    for (const app of ['backend', 'frontend'])
      run('docker', [
        'run',
        '--rm',
        '--user',
        `${process.getuid?.()}:${process.getgid?.()}`,
        '-e',
        'HOME=/tmp',
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
      ])
  }, 600_000)

  afterAll(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true })
  })

  it('verifies a new backend test file and an evidence test end to end', async () => {
    const inDir = path.join(root, 'in')
    await fs.mkdir(inDir)
    const patch =
      addedFileDiff(TEST, TEST_TEXT) + addedFileDiff(EVIDENCE, EVIDENCE_TEXT)
    writeFileSync(path.join(inDir, 'patch.diff'), patch)
    writeFileSync(
      path.join(inDir, 'patch.sha256'),
      createHash('sha256').update(patch).digest('hex'),
    )
    const report: Report = {
      files: [
        {
          path: 'backend/src/core/config.ts',
          action: 'create',
          testFile: TEST,
        },
      ],
      behaviours: [],
      defects: [
        {
          file: 'backend/src/core/config.ts',
          evidenceTest: EVIDENCE,
          summary: 'the override is rewritten',
          citation: { kind: 'pr-description', quote: QUOTE },
        },
      ],
      narrative: 'Tests for resolveDatabaseUrl.',
    }
    writeFileSync(path.join(inDir, 'report.json'), JSON.stringify(report))
    writeFileSync(
      path.join(inDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1 })}\n`,
    )
    writeFileSync(path.join(inDir, 'guard.jsonl'), '')
    const plan: Plan = {
      mode: 'pr',
      prNumber: 1,
      baseSha: 'base',
      headSha: run('git', ['rev-parse', 'HEAD'], work).trim(),
      title: 'Config',
      description: `Database configuration. ${QUOTE}`,
      draft: false,
      earlyOutcome: null,
      manifest: [
        {
          path: 'backend/src/core/config.ts',
          app: 'backend',
          status: 'modified',
          changedLines: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
          excludedOnBase: false,
        },
      ],
      dependenciesChanged: false,
      testsRemovedByAuthor: [],
      budgetProfile: 'default',
    }
    const runDir = path.join(root, 'run')
    const v = await runVerify(
      {
        trustedDir: repoRoot,
        workDir: work,
        runDir,
        plan,
        patchPath: path.join(inDir, 'patch.diff'),
        patchShaPath: path.join(inDir, 'patch.sha256'),
        reportPath: path.join(inDir, 'report.json'),
        transcriptPath: path.join(inDir, 'transcript.jsonl'),
        guardLogPath: path.join(inDir, 'guard.jsonl'),
        agentStop: 'success',
      },
      { exec, fs, image },
    )

    expect(v.outcome, v.reasons.join('\n')).toBe('defect')
    expect(v.conclusion).toBe('failure')
    expect(v.commitAllowed).toBe(true)
    expect(v.defects).toEqual([
      expect.objectContaining({ evidenceTest: EVIDENCE, accepted: true }),
    ])
    const inputs = JSON.parse(
      await fs.readFile(path.join(runDir, 'verdict-inputs.json'), 'utf8'),
    )
    expect(inputs.evidence).toEqual([
      {
        file: EVIDENCE,
        failuresOnHead: 3,
        allAssertion: true,
        citationOk: true,
      },
    ])
    expect(inputs.stability).toEqual([
      expect.objectContaining({ file: TEST, passedRuns: 3 }),
    ])
    expect(inputs.appliedPaths).toEqual({ ok: true, offending: [] })
    expect(v.numbers.backend).toMatchObject({
      typecheckBefore: true,
      typecheckAfter: true,
      stability: { passedRuns: 3, runs: 3 },
    })
    expect(v.numbers.backend.suiteAfter!.total).toBe(
      v.numbers.backend.suiteBefore.total + 3,
    )
    expect(v.numbers.backend.changedLines[0]).toMatchObject({
      before: { status: 'measured', pct: 0 },
      after: { status: 'measured', pct: 1 },
    })
    // Evidence never reaches the work copy; sandboxes are gone.
    await expect(fs.stat(path.join(work, EVIDENCE))).rejects.toThrow()
    await expect(fs.stat(path.join(work, TEST))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(runDir, 'sandbox'))).rejects.toThrow()
  }, 900_000)
})
