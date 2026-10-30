import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runVerify } from '../src/verify.ts'
import {
  addedFileDiff,
  EVIDENCE,
  EVIDENCE_TEXT,
  EXISTING_TEST,
  makeWorld,
  NEW_TEST,
  NEW_TEST_TEXT,
  report,
  vitestJson,
  type World,
} from './verify-harness.ts'

let w: World
beforeEach(async () => {
  w = await makeWorld()
})
afterEach(async () => {
  await w.cleanup()
})

const verify = () => runVerify(w.args, w.deps)
const steps = () => w.docker.map((d) => d.step)
const argOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]

describe('runVerify happy path', () => {
  it('verifies a new test file: tests-added with real inputs', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-host-secret'
    let v
    try {
      v = await verify()
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
    expect(v.outcome, v.reasons.join('\n')).toBe('tests-added')
    expect(v.conclusion).toBe('success')
    expect(v.commitAllowed).toBe(true)
    expect(v.reasons).toEqual([])

    expect(steps()).toEqual([
      'prisma-generate',
      'baseline-backend-typecheck',
      'baseline-backend-suite',
      'baseline-frontend-typecheck',
      'baseline-frontend-suite',
      'after-backend-typecheck',
      'after-backend-suite',
      'after-frontend-typecheck',
      'after-frontend-suite',
      'stability-1-seed-1',
      'stability-1-seed-2',
      'stability-1-seed-3',
      'skip-1',
    ])

    const i = await w.inputs()
    expect(i.patchTestFiles).toEqual([{ path: NEW_TEST, status: 'added' }])
    expect(i.appliedPaths).toEqual({ ok: true, offending: [] })
    expect(i.gates).toEqual({ ok: true, violations: [] })
    expect(i.patchEmpty).toBe(false)
    expect(i.stability).toEqual([
      {
        file: NEW_TEST,
        passedRuns: 3,
        tests: [1, 2, 3].map(() => ({ name: 'a is one', status: 'passed' })),
      },
    ])
    expect(i.skipChecks).toEqual([
      {
        path: 'backend/src/b.ts',
        file: EXISTING_TEST,
        testName: 'existing works',
        ok: true,
        detail: 'covers 1/1 changed lines (100%)',
      },
    ])
    expect(
      (i.after as { backend: { expectedFiles: string[] } }).backend
        .expectedFiles,
    ).toEqual([NEW_TEST, EXISTING_TEST])
    expect(v.numbers.backend).toMatchObject({
      typecheckBefore: true,
      typecheckAfter: true,
      suiteBefore: { passed: 1, total: 1 },
      suiteAfter: { passed: 2, total: 2 },
      stability: { passedRuns: 3, runs: 3 },
      appLines: null,
    })
    expect(v.numbers.backend.changedLines).toEqual([
      {
        file: 'backend/src/a.ts',
        before: { status: 'measured', covered: 0, total: 2, pct: 0 },
        after: { status: 'measured', covered: 2, total: 2, pct: 1 },
      },
      {
        file: 'backend/src/b.ts',
        before: { status: 'measured', covered: 1, total: 1, pct: 1 },
        after: { status: 'measured', covered: 1, total: 1, pct: 1 },
      },
    ])
    expect(v.patchSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await fs.readFile(path.join(w.workDir, NEW_TEST), 'utf8')).toBe(
      NEW_TEST_TEXT,
    )
  })

  it('runs every container sandboxed, without host secrets, as non-root', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-host-secret'
    try {
      await verify()
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
    for (const c of w.calls) {
      expect(c.args.join(' ')).not.toContain('ANTHROPIC_API_KEY')
      expect(c.args.join(' ')).not.toContain('sk-host-secret')
      expect(Object.keys(c.opts?.env ?? {})).not.toContain('ANTHROPIC_API_KEY')
      if (c.cmd === 'docker' && c.args[0] === 'run')
        // Explicit env so docker never inherits the host environment.
        expect(Object.keys(c.opts?.env ?? {}).sort()).toEqual(['HOME', 'PATH'])
    }
    for (const d of w.docker) {
      expect(argOf(d.argv, '--user')).toBe('1001:1001')
      expect(argOf(d.argv, '--network')).toBe(
        d.step === 'prisma-generate' ? 'default' : 'none',
      )
      expect(d.argv).toContain('--cap-drop')
      expect(d.argv).toContain('--memory')
    }
    const prisma = w.docker.find((d) => d.step === 'prisma-generate')!
    expect(prisma.command).toEqual(['npx', 'prisma', 'generate'])
    expect(prisma.appDir).toBe(path.join(w.workDir, 'backend'))
    for (const d of w.docker.filter((x) => x.step !== 'prisma-generate')) {
      // Every test/typecheck run gets its own throwaway copy (ruling R5).
      expect(d.appDir.startsWith(path.join(w.runDir, 'sandbox', d.step))).toBe(
        true,
      )
      expect(d.resultsDir).toBe(path.join(w.runDir, 'results', d.step))
    }
    const tsc = w.docker.find((d) => d.step === 'after-frontend-typecheck')!
    expect(tsc.command).toEqual([
      'npx',
      'tsc',
      '--noEmit',
      '-p',
      'tsconfig.json',
    ])
    expect(
      w.docker.find((d) => d.step === 'baseline-backend-suite')!.command,
    ).toContain('--coverage.enabled=true')
    await expect(fs.readdir(path.join(w.runDir, 'sandbox'))).rejects.toThrow()
  })

  it('keeps each container output in runDir/logs, outside the container-writable results', async () => {
    await verify()
    for (const step of ['prisma-generate', 'after-backend-typecheck', 'skip-1'])
      expect(
        await fs.readFile(path.join(w.runDir, 'logs', `${step}.log`), 'utf8'),
      ).toBe(`exit 0\n--- stdout\nout of ${step}\n--- stderr\nerr of ${step}\n`)
  })

  it('runs stability with seeds 1-3, shuffled, in three time zones', async () => {
    await verify()
    const runs = w.docker.filter((d) => d.step.startsWith('stability-'))
    expect(runs.map((d) => argOf(d.argv, '-e'))).toEqual([
      'TZ=UTC',
      'TZ=America/Los_Angeles',
      'TZ=Asia/Kolkata',
    ])
    expect(
      runs.map((d) => d.command.filter((a) => a.startsWith('--sequence'))),
    ).toEqual(
      [1, 2, 3].map((s) => ['--sequence.shuffle=true', `--sequence.seed=${s}`]),
    )
    for (const d of runs) expect(d.command.at(-1)).toBe('tests/a.test.ts')
  })
})

describe('runVerify rejections and failures', () => {
  it('patch hash mismatch -> patch-rejected, nothing applied or run after', async () => {
    await w.writePatch(addedFileDiff(NEW_TEST, NEW_TEST_TEXT), 'f'.repeat(64))
    const v = await verify()
    expect(v.outcome).toBe('patch-rejected')
    expect(v.reasons.join('\n')).toMatch(/sha256 mismatch/)
    expect(steps().some((s) => s.startsWith('after-'))).toBe(false)
    expect(w.calls.some((c) => c.cmd === 'git' && c.args[0] === 'apply')).toBe(
      false,
    )
    await expect(fs.stat(path.join(w.workDir, NEW_TEST))).rejects.toThrow()
  })

  it('gate violation -> patch-rejected before apply', async () => {
    await w.writePatch(
      addedFileDiff(NEW_TEST, `${NEW_TEST_TEXT}it.skip('later', () => {})\n`),
    )
    const v = await verify()
    expect(v.outcome).toBe('patch-rejected')
    expect(v.reasons.join('\n')).toMatch(/forbidden-call/)
    expect(w.calls.some((c) => c.cmd === 'git' && c.args[0] === 'apply')).toBe(
      false,
    )
  })

  it('container exits non-zero with no JSON -> pipeline-error', async () => {
    w.onDocker = async (run, defaults) =>
      run.step === 'baseline-backend-suite' ? { code: 137 } : defaults()
    const v = await verify()
    expect(v.outcome).toBe('pipeline-error')
    expect(v.reasons.join('\n')).toMatch(
      /verify: baseline backend suite unusable: run\.json missing/,
    )
    expect(steps().some((s) => s.startsWith('after-'))).toBe(false)
  })

  it('exit 1 with a report that shows no failure (e.g. head thresholds) -> pipeline-error', async () => {
    w.onDocker = async (run, defaults) => {
      const r = await defaults()
      return run.step === 'after-backend-suite' ? { ...r, code: 1 } : r
    }
    const v = await verify()
    expect(v.outcome).toBe('pipeline-error')
    expect(v.reasons.join('\n')).toMatch(/after backend suite unusable: exit 1/)
  })

  it('a results file that is a symlink is not read', async () => {
    w.onDocker = async (run, defaults) => {
      const r = await defaults()
      if (run.step !== 'baseline-frontend-suite') return r
      await fs.writeFile(
        path.join(run.resultsDir, 'real.json'),
        JSON.stringify(r.json),
      )
      await fs.symlink('real.json', path.join(run.resultsDir, 'run.json'))
      return { ...r, json: null }
    }
    const v = await verify()
    expect(v.outcome).toBe('pipeline-error')
    expect(v.reasons.join('\n')).toMatch(/run\.json is not a regular file/)
  })

  it('stability seed 2 fails -> verification-failed', async () => {
    w.onDocker = async (run, defaults) => {
      if (run.step !== 'stability-1-seed-2') return defaults()
      return {
        code: 1,
        json: vitestJson([
          {
            file: 'tests/a.test.ts',
            tests: [
              {
                name: 'a is one',
                status: 'failed',
                message: 'AssertionError: expected 1 to be 2',
              },
            ],
          },
        ]),
      }
    }
    const v = await verify()
    expect(v.outcome).toBe('verification-failed')
    expect(v.reasons.join('\n')).toMatch(/passed 2\/3 stability runs/)
    const i = await w.inputs()
    expect((i.stability as { tests: unknown[] }[])[0]!.tests).toContainEqual({
      name: 'a is one',
      status: 'failed',
    })
  })

  it('baseline failing -> baseline-failing, patch never applied', async () => {
    w.onDocker = async (run, defaults) => {
      if (run.step !== 'baseline-backend-suite') return defaults()
      const r = await defaults()
      return {
        ...r,
        code: 1,
        json: vitestJson([
          {
            file: 'tests/existing.test.ts',
            tests: [
              {
                name: 'existing works',
                status: 'failed',
                message: 'AssertionError: x',
              },
            ],
          },
        ]),
      }
    }
    const v = await verify()
    expect(v.outcome).toBe('baseline-failing')
    expect(v.baselineFailures).toEqual([
      {
        app: 'backend',
        tests: [`${EXISTING_TEST} > existing works`],
        typecheck: false,
      },
    ])
    expect(w.calls.some((c) => c.cmd === 'git' && c.args[0] === 'apply')).toBe(
      false,
    )
  })

  it('typecheck exit 2 with a TS diagnostic is a type error (verification-failed)', async () => {
    w.onDocker = async (run, defaults) =>
      run.step === 'after-backend-typecheck'
        ? {
            code: 2,
            stdout:
              'tests/a.test.ts(2,36): error TS2835: Relative import paths need explicit file extensions.',
          }
        : defaults()
    const v = await verify()
    expect(v.outcome).toBe('verification-failed')
    expect(v.reasons).toContain('backend: typecheck fails after the patch')
  })

  it('lists the first TS diagnostics so the author can see what to fix', async () => {
    const diagnostics = [1, 2, 3, 4]
      .map((n) => `tests/router.test.ts(${n},1): error TS2345: problem ${n}.`)
      .join('\n')
    w.onDocker = async (run, defaults) =>
      run.step === 'baseline-backend-typecheck'
        ? { code: 2, stdout: `${diagnostics}\nFound 4 errors.` }
        : defaults()
    const v = await verify()
    expect(v.outcome).toBe('baseline-failing')
    const reasons = v.reasons.join('\n')
    expect(reasons).toContain(
      'tests/router.test.ts(1,1): error TS2345: problem 1.',
    )
    expect(reasons).toContain(
      'tests/router.test.ts(3,1): error TS2345: problem 3.',
    )
    expect(reasons).not.toContain('problem 4.')
    expect(reasons).toContain('(+1 more)')
  })

  it.each([1, 2])(
    'typecheck exit %i without a TS diagnostic is unusable (pipeline-error)',
    async (code) => {
      w.onDocker = async (run, defaults) =>
        run.step === 'baseline-backend-typecheck'
          ? { code, stdout: 'npm error could not determine executable to run' }
          : defaults()
      const v = await verify()
      expect(v.outcome).toBe('pipeline-error')
      expect(v.reasons.join('\n')).toMatch(
        new RegExp(
          `baseline backend typecheck unusable: exit ${code} without a TS diagnostic`,
        ),
      )
    },
  )

  it('typecheck that cannot run (docker error) is a pipeline-error, not baseline-failing', async () => {
    w.onDocker = async (run, defaults) =>
      run.step === 'baseline-frontend-typecheck' ? { code: 125 } : defaults()
    const v = await verify()
    expect(v.outcome).toBe('pipeline-error')
    expect(v.reasons.join('\n')).toMatch(
      /baseline frontend typecheck unusable: exit 125/,
    )
  })

  it('R6: git apply writing outside the gated set -> patch-rejected', async () => {
    w.onApply = async (cwd) => {
      if (cwd === w.workDir)
        await fs.writeFile(path.join(cwd, 'backend/src/evil.ts'), 'x\n')
    }
    const v = await verify()
    expect(v.outcome).toBe('patch-rejected')
    expect(v.reasons.join('\n')).toMatch(
      /backend\/src\/evil\.ts: changed by git apply outside the gated set/,
    )
    expect(steps().some((s) => s.startsWith('after-'))).toBe(false)
  })

  it('R12: applied content that differs from the patch -> patch-rejected', async () => {
    w.onApply = async (cwd) => {
      if (cwd === w.workDir)
        await fs.appendFile(
          path.join(cwd, NEW_TEST),
          "it.only('x', () => {})\n",
        )
    }
    const v = await verify()
    expect(v.outcome).toBe('patch-rejected')
    expect(v.reasons.join('\n')).toMatch(/integrity/)
    expect(v.reasons.join('\n')).toMatch(/forbidden-call/)
  })

  it('work dir not at the analysed head -> pipeline-error', async () => {
    w.head = 'other-sha'
    const v = await verify()
    expect(v.outcome).toBe('pipeline-error')
    expect(v.reasons.join('\n')).toMatch(/not the analysed head/)
    expect(w.docker).toEqual([])
  })
})

describe('runVerify environment hardening', () => {
  it.each([
    ['inside', (work: string) => path.join(work, 'run')],
    ['equal to', (work: string) => work],
    ['inside (unnormalised)', (work: string) => `${work}/x/../run`],
  ])('refuses a run dir %s the work dir', async (_, runDir) => {
    w.args.runDir = runDir(w.workDir)
    await expect(verify()).rejects.toThrow(
      /run dir must be outside the work dir/,
    )
    expect(w.calls).toEqual([])
  })

  it('accepts a sibling whose name starts with the work dir name', async () => {
    w.args.runDir = `${w.workDir}-run`
    const v = await verify()
    expect(v.outcome).toBe('tests-added')
    await fs.rm(w.args.runDir, { recursive: true, force: true })
  })

  it('runs git without user or system config', async () => {
    await verify()
    const gitCalls = w.calls.filter((c) => c.cmd === 'git')
    expect(gitCalls.length).toBeGreaterThan(0)
    for (const c of gitCalls)
      expect(c.opts?.env).toMatchObject({
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: process.env.HOME ?? '',
      })
  })
})

describe('runVerify agent-phase outcomes run nothing', () => {
  it('plan early outcome', async () => {
    w.args.plan = { ...w.args.plan, earlyOutcome: 'draft', draft: true }
    w.args.agentStop = null
    const v = await verify()
    expect(v.outcome).toBe('draft')
    expect(w.calls).toEqual([])
  })

  it('budget exhausted', async () => {
    w.args.agentStop = 'max-turns'
    const v = await verify()
    expect(v.outcome).toBe('budget-exhausted')
    expect(w.calls).toEqual([])
  })

  it('tool use without a guard record', async () => {
    await fs.writeFile(w.args.guardLogPath, '')
    const v = await verify()
    expect(v.outcome).toBe('agent-run-invalid')
    expect(v.reasons.join('\n')).toMatch(/toolu_1/)
    expect(w.calls).toEqual([])
  })

  it('a call to a tool that does not exist needs no guard record', async () => {
    const transcript = await fs.readFile(w.args.transcriptPath, 'utf8')
    const extra = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_glob', name: 'Glob', input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_glob',
              is_error: true,
              content:
                '<tool_use_error>Error: No such tool available: Glob.</tool_use_error>',
            },
          ],
        },
      }),
    ]
    await fs.writeFile(w.args.transcriptPath, [...extra, transcript].join('\n'))
    const v = await verify()
    expect(v.outcome).not.toBe('agent-run-invalid')
    expect(v.reasons.join('\n')).not.toMatch(/toolu_glob/)
  })

  it('missing transcript is agent-run-invalid', async () => {
    await fs.rm(w.args.transcriptPath)
    const v = await verify()
    expect(v.outcome).toBe('agent-run-invalid')
  })

  it('invalid report JSON', async () => {
    await fs.writeFile(w.args.reportPath, '{')
    const v = await verify()
    expect(v.outcome).toBe('pipeline-error')
    expect(v.reasons.join('\n')).toMatch(/report\.json is not valid JSON/)
    expect(w.calls).toEqual([])
  })
})

describe('runVerify skip checks (R16)', () => {
  it('coverage below the policy minimum -> skip-unverified', async () => {
    w.onDocker = async (run, defaults) => {
      const r = await defaults()
      if (run.step !== 'skip-1') return r
      const cov = r.coverage as Record<string, { s: Record<string, number> }>
      cov['/app/src/b.ts']!.s = { '0': 0 }
      return r
    }
    const v = await verify()
    expect(v.outcome).toBe('skip-unverified')
    const i = await w.inputs()
    expect(i.skipChecks).toEqual([
      {
        path: 'backend/src/b.ts',
        file: EXISTING_TEST,
        testName: 'existing works',
        ok: false,
        detail: 'covers 0/1 changed lines (0%), below 80%',
      },
    ])
  })

  it('runs the cited file alone with coverage on head', async () => {
    await verify()
    const run = w.docker.find((d) => d.step === 'skip-1')!
    expect(run.command).toContain('--coverage.enabled=true')
    expect(run.command.at(-1)).toBe('tests/existing.test.ts')
    // Head copy: the agent's new test file is not there.
    expect(run.testFiles).not.toContain('tests/a.test.ts')
  })

  it.each([
    [
      { file: 'backend/tests/missing.test.ts', testName: 'x' },
      'cited file does not exist on head',
    ],
    [
      { file: EXISTING_TEST, testName: 'no such test' },
      'cited test not found in the run',
    ],
    [
      { file: 'backend/tests/--config=x.test.ts', testName: 'x' },
      'cited file is not a runnable test file',
    ],
    [
      { file: 'backend/src/b.ts', testName: 'x' },
      'cited file is not a runnable test file',
    ],
  ])('cited %j -> not ok (%s)', async (skip, detail) => {
    const r = report()
    r.files[1] = { path: 'backend/src/b.ts', action: 'skip', skip }
    await w.writeReport(r)
    const v = await verify()
    expect(v.outcome).toBe('skip-unverified')
    const i = await w.inputs()
    expect(i.skipChecks).toEqual([
      { path: 'backend/src/b.ts', ...skip, ok: false, detail },
    ])
    // Model-supplied paths never reach docker unless they pass the runner rules.
    for (const d of w.docker)
      expect(d.argv.join(' ')).not.toContain('--config=x')
  })

  it('a cited test that fails on head is not ok', async () => {
    w.onDocker = async (run, defaults) => {
      const r = await defaults()
      if (run.step !== 'skip-1') return r
      return {
        ...r,
        code: 1,
        json: vitestJson([
          {
            file: 'tests/existing.test.ts',
            tests: [
              {
                name: 'existing works',
                status: 'failed',
                message: 'AssertionError: x',
              },
            ],
          },
        ]),
      }
    }
    const v = await verify()
    expect(v.outcome).toBe('skip-unverified')
    const i = await w.inputs()
    expect((i.skipChecks as { detail: string }[])[0]!.detail).toBe(
      'cited test is failed',
    )
  })
})

describe('runVerify evidence (ADR 0014)', () => {
  const defect = () => {
    const r = report()
    r.defects = [
      {
        file: 'backend/src/a.ts',
        evidenceTest: EVIDENCE,
        summary: 'a is not two',
        citation: {
          kind: 'openapi',
          pointer: '/paths/~1todos/post/responses/422',
        },
      },
    ]
    return r
  }
  const patchWithEvidence = () =>
    addedFileDiff(NEW_TEST, NEW_TEST_TEXT) +
    addedFileDiff(EVIDENCE, EVIDENCE_TEXT)
  const failing =
    (message: string) =>
    async (
      run: { step: string },
      defaults: () => Promise<{ code: number }>,
    ) => {
      if (!run.step.startsWith('evidence-')) return defaults()
      return {
        code: 1,
        json: vitestJson([
          {
            file: 'tests/__evidence__/a.test.ts',
            tests: [{ name: 'a should be two', status: 'failed', message }],
          },
        ]),
      }
    }

  it('three assertion failures on head and a valid citation -> defect', async () => {
    await w.writePatch(patchWithEvidence())
    await w.writeReport(defect())
    w.onDocker = failing('AssertionError: expected 1 to be 2')
    const v = await verify()
    expect(v.outcome, v.reasons.join('\n')).toBe('defect')
    expect(v.conclusion).toBe('failure')
    expect(v.commitAllowed).toBe(true)
    const i = await w.inputs()
    expect(i.evidence).toEqual([
      {
        file: EVIDENCE,
        failuresOnHead: 3,
        allAssertion: true,
        citationOk: true,
      },
    ])
    const runs = w.docker.filter((d) => d.step.startsWith('evidence-'))
    expect(runs.map((d) => d.step)).toEqual([
      'evidence-1-run-1',
      'evidence-1-run-2',
      'evidence-1-run-3',
    ])
    for (const d of runs) {
      // Head plus only the evidence file.
      expect(d.testFiles.sort()).toEqual([
        'tests/__evidence__/a.test.ts',
        'tests/existing.test.ts',
      ])
      expect(argOf(d.argv, '--network')).toBe('none')
      expect(d.command.at(-1)).toBe('tests/__evidence__/a.test.ts')
    }
    // Never applied to the work copy, so never in after or stability runs.
    for (const d of w.docker.filter((x) => !x.step.startsWith('evidence-')))
      expect(d.testFiles).not.toContain('tests/__evidence__/a.test.ts')
    await expect(fs.stat(path.join(w.workDir, EVIDENCE))).rejects.toThrow()
    expect(i.patchTestFiles).toEqual([{ path: NEW_TEST, status: 'added' }])
  })

  it('a non-assertion failure rejects the defect claim', async () => {
    await w.writePatch(patchWithEvidence())
    await w.writeReport(defect())
    w.onDocker = failing('TypeError: x is not a function')
    const v = await verify()
    expect(v.outcome).toBe('tests-added')
    expect(v.defects[0]).toMatchObject({
      accepted: false,
      rejectReason: 'a failure was not an assertion failure',
    })
  })

  it('a citation that does not resolve rejects the defect claim', async () => {
    await w.writePatch(patchWithEvidence())
    const r = defect()
    r.defects[0]!.citation = {
      kind: 'pr-description',
      quote: 'titles must be unique per user',
    }
    await w.writeReport(r)
    w.onDocker = failing('AssertionError: expected 1 to be 2')
    const v = await verify()
    expect(v.outcome).toBe('tests-added')
    expect(v.defects[0]).toMatchObject({
      accepted: false,
      rejectReason: 'citation not found',
    })
  })

  it('evidence that passes on head is rejected', async () => {
    await w.writePatch(patchWithEvidence())
    await w.writeReport(defect())
    const v = await verify()
    expect(v.outcome).toBe('tests-added')
    expect(v.defects[0]!.rejectReason).toMatch(/failed on 0\/3 head runs/)
  })

  it('evidence content is gated after apply too (R12)', async () => {
    await w.writePatch(patchWithEvidence())
    await w.writeReport(defect())
    w.onApply = async (cwd) => {
      if (cwd !== w.workDir)
        await fs.appendFile(
          path.join(cwd, EVIDENCE),
          "it.only('x', () => {})\n",
        )
    }
    const v = await verify()
    expect(v.outcome).toBe('patch-rejected')
    expect(v.reasons.join('\n')).toMatch(/__evidence__\/a\.test\.ts: integrity/)
  })
})

describe('runVerify patch shapes', () => {
  it('only skips (empty patch) -> already-covered after a full verification', async () => {
    await w.writePatch('')
    const r = report()
    r.files[0] = {
      path: 'backend/src/a.ts',
      action: 'skip',
      skip: { file: EXISTING_TEST, testName: 'existing works' },
    }
    await w.writeReport(r)
    w.onDocker = async (run, defaults) => {
      const res = await defaults()
      // The existing test covers a.ts as well in this scenario.
      const cov = res.coverage as
        Record<string, { s: Record<string, number> }> | undefined
      if (cov?.['/app/src/a.ts']) cov['/app/src/a.ts'].s = { '0': 1, '1': 1 }
      return res
    }
    const v = await verify()
    expect(v.outcome, v.reasons.join('\n')).toBe('already-covered')
    expect(v.commitAllowed).toBe(false)
    expect(w.calls.some((c) => c.cmd === 'git' && c.args[0] === 'apply')).toBe(
      false,
    )
    expect(steps()).toContain('after-backend-suite')
    // Both skips cite the same file: one run, two checks.
    expect(steps().filter((s) => s.startsWith('skip-'))).toEqual(['skip-1'])
    expect(((await w.inputs()).skipChecks as unknown[]).length).toBe(2)
  })

  it('modified existing test file: stability and R12 on the whole file', async () => {
    const diff = `diff --git a/${EXISTING_TEST} b/${EXISTING_TEST}\nindex 1111111..2222222 100644\n--- a/${EXISTING_TEST}\n+++ b/${EXISTING_TEST}\n@@ -6,0 +7,4 @@\n+\n+it('existing again', () => {\n+  expect(b).toBe(1)\n+})\n`
    await w.writePatch(diff)
    const r = report()
    r.files[0] = { path: 'backend/src/a.ts', action: 'gave-up' }
    r.files[1] = {
      path: 'backend/src/b.ts',
      action: 'update',
      testFile: EXISTING_TEST,
    }
    await w.writeReport(r)
    const v = await verify()
    expect(v.outcome, v.reasons.join('\n')).toBe('tests-added')
    const i = await w.inputs()
    expect(i.patchTestFiles).toEqual([
      { path: EXISTING_TEST, status: 'modified' },
    ])
    expect(
      (i.stability as { tests: { name: string }[] }[])[0]!.tests.map(
        (t) => t.name,
      ),
    ).toEqual([1, 2, 3].flatMap(() => ['existing works', 'existing again']))
  })

  it('backfill mode reports app-wide line coverage', async () => {
    w.args.plan = {
      ...w.args.plan,
      mode: 'backfill',
      prNumber: null,
      budgetProfile: 'backfill',
    }
    const v = await verify()
    expect(v.outcome).toBe('tests-added')
    expect(v.numbers.backend.appLines).toEqual({ before: 1 / 3, after: 1 })
    expect(v.numbers.frontend.appLines).toBeNull()
  })
})
