import { describe, expect, it } from 'vitest'
import { loadPolicy } from '../src/policy.ts'
import type { Report } from '../src/report.ts'
import type { Conclusion, Mode, Outcome, Plan } from '../src/types.ts'
import {
  computeVerdict,
  conclusionFor,
  type AppNumbers,
  type VerdictInputs,
} from '../src/verdict.ts'
import type { RunSummary, TestStatus } from '../src/vitest-results.ts'

const policy = loadPolicy()

type Row = [file: string, name: string, status: TestStatus]

function run(rows: Row[]): RunSummary {
  const s: RunSummary = {
    files: [],
    total: 0,
    passed: 0,
    failed: 0,
    failures: [],
    tests: [],
    skipped: 0,
    todo: 0,
    passedByFile: {},
    failsMode: [],
  }
  for (const [file, name, status] of rows) {
    if (!s.files.includes(file)) {
      s.files.push(file)
      s.passedByFile[file] = 0
    }
    s.total++
    s.tests.push({ file, name, status })
    if (status === 'passed') {
      s.passed++
      s.passedByFile[file]!++
    } else if (status === 'skipped') s.skipped++
    else if (status === 'todo') s.todo++
    else {
      s.failed++
      s.failures.push({
        file,
        name,
        isAssertion: status === 'failed',
        message: 'AssertionError: x',
      })
    }
  }
  return s
}

const A = 'backend/tests/a.test.ts' // new test file
const D = 'backend/tests/d.test.ts' // existing test file, modified by the patch
const B = 'backend/tests/b.test.ts' // existing, cited by a skip
const LEGACY = 'backend/tests/legacy.test.ts' // untouched, has a skipped test on base
const X = 'frontend/src/x.test.tsx'
const EVIDENCE = 'backend/tests/__evidence__/a.test.ts'

const baselineBackend: Row[] = [
  [B, 'covers b', 'passed'],
  [D, 'd1', 'passed'],
  [D, 'd2', 'passed'],
  [LEGACY, 'old', 'skipped'],
]
const afterBackend: Row[] = [
  ...baselineBackend,
  [A, 'a1', 'passed'],
  [A, 'a2', 'passed'],
  [D, 'd3', 'passed'],
]
const frontendRows: Row[] = [[X, 'x', 'passed']]

const numbers = (): Record<'backend' | 'frontend', AppNumbers> => ({
  backend: {
    typecheckBefore: true,
    typecheckAfter: true,
    suiteBefore: { passed: 3, total: 4 },
    suiteAfter: { passed: 6, total: 7 },
    stability: { passedRuns: 3, runs: 3 },
    changedLines: [
      {
        file: 'backend/src/a.ts',
        before: { status: 'measured', covered: 0, total: 4, pct: 0 },
        after: { status: 'measured', covered: 4, total: 4, pct: 1 },
      },
      {
        file: 'backend/src/e.ts',
        before: { status: 'missing', covered: 0, total: 0, pct: null },
        after: null,
      },
    ],
    appLines: null,
  },
  frontend: {
    typecheckBefore: true,
    typecheckAfter: true,
    suiteBefore: { passed: 1, total: 1 },
    suiteAfter: { passed: 1, total: 1 },
    stability: null,
    changedLines: [],
    appLines: null,
  },
})

const plan = (): Plan => ({
  mode: 'pr',
  prNumber: 7,
  baseSha: 'base',
  headSha: 'head',
  title: 'Add a',
  description: 'The endpoint must return 422 for empty titles.',
  draft: false,
  earlyOutcome: null,
  manifest: [
    {
      path: 'backend/src/a.ts',
      app: 'backend',
      status: 'added',
      changedLines: [1, 2],
      excludedOnBase: false,
    },
    {
      path: 'backend/src/b.ts',
      app: 'backend',
      status: 'modified',
      changedLines: [3],
      excludedOnBase: false,
    },
    {
      path: 'backend/src/d.ts',
      app: 'backend',
      status: 'modified',
      changedLines: [5],
      excludedOnBase: false,
    },
    {
      path: 'frontend/src/c.tsx',
      app: 'frontend',
      status: 'modified',
      changedLines: [9],
      excludedOnBase: true,
    },
  ],
  dependenciesChanged: false,
  testsRemovedByAuthor: [],
  budgetProfile: 'default',
})

const report = (): Report => ({
  files: [
    { path: 'backend/src/a.ts', action: 'create', testFile: A },
    {
      path: 'backend/src/b.ts',
      action: 'skip',
      skip: { file: B, testName: 'covers b' },
    },
    { path: 'backend/src/d.ts', action: 'update', testFile: D },
    {
      path: 'frontend/src/c.tsx',
      action: 'skip',
      skip: { reason: 'excluded-from-coverage' },
    },
  ],
  behaviours: [],
  defects: [],
  narrative: 'All good.',
})

const defect = (): Report['defects'][number] => ({
  file: 'backend/src/a.ts',
  evidenceTest: EVIDENCE,
  summary: 'accepts empty titles',
  citation: {
    kind: 'pr-description',
    quote: 'must return 422 for empty titles',
  },
})

const goodEvidence = () => ({
  file: EVIDENCE,
  failuresOnHead: 3,
  allAssertion: true,
  citationOk: true,
})

function inputs(): VerdictInputs {
  return {
    plan: plan(),
    policy,
    agentStop: 'success',
    report: { ok: true, report: report() },
    gates: { ok: true, violations: [] },
    appliedPaths: { ok: true, offending: [] },
    unguardedToolUses: [],
    baseline: {
      backend: { typecheck: true, suite: run(baselineBackend) },
      frontend: { typecheck: true, suite: run(frontendRows) },
    },
    after: {
      backend: {
        typecheck: true,
        suite: run(afterBackend),
        expectedFiles: [B, D, LEGACY, A],
      },
      frontend: {
        typecheck: true,
        suite: run(frontendRows),
        expectedFiles: [X],
      },
    },
    modifiedTestFiles: [D],
    stability: [
      {
        file: A,
        passedRuns: 3,
        tests: [1, 2, 3].flatMap(() => [
          { name: 'a1', status: 'passed' },
          { name: 'a2', status: 'passed' },
        ]),
      },
      {
        file: D,
        passedRuns: 3,
        tests: [1, 2, 3].flatMap(() =>
          ['d1', 'd2', 'd3'].map((name) => ({ name, status: 'passed' })),
        ),
      },
    ],
    skipChecks: [{ path: 'backend/src/b.ts', ok: true, detail: '100%' }],
    evidence: [],
    numbers: numbers(),
    patchSha256: 'abc123',
    patchEmpty: false,
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v)
    Object.freeze(o)
  }
  return o
}

/** Report patch with nothing but skips, all verified. */
function alreadyCovered(i: VerdictInputs) {
  i.patchEmpty = true
  i.modifiedTestFiles = []
  i.stability = []
  i.after!.backend.suite = run(baselineBackend)
  i.after!.backend.expectedFiles = [B, D, LEGACY]
  i.report = {
    ok: true,
    report: {
      ...report(),
      files: [
        {
          path: 'backend/src/a.ts',
          action: 'skip',
          skip: { file: B, testName: 'covers b' },
        },
        {
          path: 'backend/src/b.ts',
          action: 'skip',
          skip: { file: B, testName: 'covers b' },
        },
        {
          path: 'backend/src/d.ts',
          action: 'skip',
          skip: { file: D, testName: 'd1' },
        },
        {
          path: 'frontend/src/c.tsx',
          action: 'skip',
          skip: { reason: 'excluded-from-coverage' },
        },
      ],
    },
  }
  i.skipChecks = ['a', 'b', 'd'].map((n) => ({
    path: `backend/src/${n}.ts`,
    ok: true,
    detail: '90%',
  }))
}

function withDefect(i: VerdictInputs, evidence = goodEvidence()) {
  if (!i.report?.ok) throw new Error('fixture')
  i.report.report.defects = [defect()]
  i.evidence = [evidence]
}

interface Case {
  name: string
  mutate: (i: VerdictInputs) => void
  outcome: Outcome
  conclusion: Conclusion
  commitAllowed: boolean
  reason?: RegExp
}

const cases: Case[] = [
  // --- spec §9.1, one row per outcome code ---
  {
    name: 'tests-added: verified non-empty patch',
    mutate: () => {},
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
  },
  {
    name: 'already-covered: empty patch, every skip verified',
    mutate: alreadyCovered,
    outcome: 'already-covered',
    conclusion: 'success',
    commitAllowed: false,
  },
  {
    name: 'nothing-to-test: plan early outcome',
    mutate: (i) => {
      i.plan.earlyOutcome = 'nothing-to-test'
      i.plan.manifest = []
      i.agentStop = null
      i.report = null
      i.gates = null
      i.appliedPaths = null
      i.baseline = null
      i.after = null
    },
    outcome: 'nothing-to-test',
    conclusion: 'success',
    commitAllowed: false,
  },
  {
    name: 'draft: plan early outcome',
    mutate: (i) => {
      i.plan.earlyOutcome = 'draft'
      i.plan.draft = true
      i.agentStop = null
      i.report = null
    },
    outcome: 'draft',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'config-changed: plan early outcome',
    mutate: (i) => {
      i.plan.earlyOutcome = 'config-changed'
      i.agentStop = null
      i.report = null
    },
    outcome: 'config-changed',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'budget-exhausted: max-turns',
    mutate: (i) => {
      i.agentStop = 'max-turns'
    },
    outcome: 'budget-exhausted',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'budget-exhausted: max-budget',
    mutate: (i) => {
      i.agentStop = 'max-budget'
    },
    outcome: 'budget-exhausted',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'timeout',
    mutate: (i) => {
      i.agentStop = 'timeout'
    },
    outcome: 'timeout',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'patch-rejected: gate violation',
    mutate: (i) => {
      i.gates = {
        ok: false,
        violations: [{ file: A, rule: 'forbidden-call', detail: '.skip(' }],
      }
    },
    outcome: 'patch-rejected',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /a\.test\.ts.*forbidden-call/,
  },
  {
    name: 'patch-rejected: gates ok flag with violations listed',
    mutate: (i) => {
      i.gates = {
        ok: true,
        violations: [{ file: A, rule: 'no-expect', detail: 'x' }],
      }
    },
    outcome: 'patch-rejected',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'patch-rejected (R6): applied paths outside the allowed set',
    mutate: (i) => {
      i.appliedPaths = { ok: false, offending: ['backend/src/a.ts'] }
    },
    outcome: 'patch-rejected',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /backend\/src\/a\.ts/,
  },
  {
    name: 'verification-failed: typecheck fails after the patch',
    mutate: (i) => {
      i.after!.frontend.typecheck = false
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /frontend.*typecheck/,
  },
  {
    name: 'verification-failed: a test fails after the patch',
    mutate: (i) => {
      i.after!.backend.suite = run([
        ...baselineBackend,
        [A, 'a1', 'passed'],
        [A, 'a2', 'failed'],
        [D, 'd3', 'passed'],
      ])
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /a\.test\.ts > a2/,
  },
  {
    name: 'verification-failed: test count after < before',
    mutate: (i) => {
      i.after!.frontend.suite = run([])
      i.after!.frontend.expectedFiles = []
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /frontend: test count dropped from 1 to 0/,
  },
  {
    name: 'verification-failed: flaky under stability (2/3)',
    mutate: (i) => {
      i.stability[0]!.passedRuns = 2
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /a\.test\.ts.*2\/3/,
  },
  {
    name: 'skip-unverified: skip check failed',
    mutate: (i) => {
      i.skipChecks = [
        { path: 'backend/src/b.ts', ok: false, detail: 'covers 40%' },
      ]
    },
    outcome: 'skip-unverified',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /b\.ts.*covers 40%/,
  },
  {
    name: 'discovery-mismatch: expected file not executed',
    mutate: (i) => {
      i.after!.backend.expectedFiles.push('backend/tests/ghost.test.ts')
    },
    outcome: 'discovery-mismatch',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /ghost\.test\.ts/,
  },
  {
    name: 'agent-run-invalid: unguarded tool uses',
    mutate: (i) => {
      i.unguardedToolUses = ['toolu_1']
    },
    outcome: 'agent-run-invalid',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /toolu_1/,
  },
  {
    name: 'baseline-failing: typecheck on head',
    mutate: (i) => {
      i.baseline!.backend.typecheck = false
    },
    outcome: 'baseline-failing',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'baseline-failing: failing existing test on head',
    mutate: (i) => {
      i.baseline!.frontend.suite = run([[X, 'x', 'failed']])
    },
    outcome: 'baseline-failing',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'pipeline-error: report invalid',
    mutate: (i) => {
      i.report = { ok: false, errors: ['/files must be array'] }
    },
    outcome: 'pipeline-error',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /must be array/,
  },
  {
    name: 'pipeline-error: report missing',
    mutate: (i) => {
      i.report = null
    },
    outcome: 'pipeline-error',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'pipeline-error: agent error',
    mutate: (i) => {
      i.agentStop = 'error'
    },
    outcome: 'pipeline-error',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'pipeline-error: agent stop unknown',
    mutate: (i) => {
      i.agentStop = 'unknown'
    },
    outcome: 'pipeline-error',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'pipeline-error: agent stop missing without an early outcome',
    mutate: (i) => {
      i.agentStop = null
    },
    outcome: 'pipeline-error',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'pipeline-error: baseline results missing',
    mutate: (i) => {
      i.baseline = null
    },
    outcome: 'pipeline-error',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'pipeline-error: gate results missing',
    mutate: (i) => {
      i.gates = null
    },
    outcome: 'pipeline-error',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'pipeline-error: applied paths missing',
    mutate: (i) => {
      i.appliedPaths = null
    },
    outcome: 'pipeline-error',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'pipeline-error: after results missing',
    mutate: (i) => {
      i.after = null
    },
    outcome: 'pipeline-error',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'defect (pr mode, verified evidence): failure, other tests committed',
    mutate: (i) => withDefect(i),
    outcome: 'defect',
    conclusion: 'failure',
    commitAllowed: true,
  },
  {
    name: 'defect (backfill mode): outcome unaffected, other tests committed',
    mutate: (i) => {
      i.plan.mode = 'backfill'
      i.plan.prNumber = null
      withDefect(i)
    },
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
  },

  // --- brief extras ---
  {
    name: 'defect + one flaky test: defect, nothing committed',
    mutate: (i) => {
      withDefect(i)
      i.stability[1]!.passedRuns = 1
    },
    outcome: 'defect',
    conclusion: 'failure',
    commitAllowed: false,
    reason: /d\.test\.ts.*1\/3/,
  },
  {
    name: 'defect with allAssertion false: rejected, tests-added',
    mutate: (i) => withDefect(i, { ...goodEvidence(), allAssertion: false }),
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
  },
  {
    name: 'defect whose quote was not found: rejected',
    mutate: (i) => withDefect(i, { ...goodEvidence(), citationOk: false }),
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
  },
  {
    name: 'defect failing on 2 of 3 head runs: rejected',
    mutate: (i) => withDefect(i, { ...goodEvidence(), failuresOnHead: 2 }),
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
  },
  {
    name: 'defect whose evidence test is not an evidence path: rejected',
    mutate: (i) => {
      withDefect(i, { ...goodEvidence(), file: A })
      if (i.report?.ok) i.report.report.defects[0]!.evidenceTest = A
    },
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
  },
  {
    name: 'defect without an evidence run: rejected',
    mutate: (i) => {
      withDefect(i)
      i.evidence = []
    },
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
  },
  {
    name: 'defect on an already-covered run: defect, nothing to commit',
    mutate: (i) => {
      alreadyCovered(i)
      withDefect(i)
    },
    outcome: 'defect',
    conclusion: 'failure',
    commitAllowed: false,
  },
  {
    name: 'defect does not override an untrusted run (agent-run-invalid)',
    mutate: (i) => {
      withDefect(i)
      i.unguardedToolUses = ['toolu_9']
    },
    outcome: 'agent-run-invalid',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'defect does not override a rejected patch',
    mutate: (i) => {
      withDefect(i)
      i.gates = {
        ok: false,
        violations: [{ file: EVIDENCE, rule: 'snapshot', detail: 'x' }],
      }
    },
    outcome: 'patch-rejected',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'gave-up file with a non-empty patch: tests-added',
    mutate: (i) => {
      if (i.report?.ok)
        i.report.report.files.push({
          path: 'backend/src/b.ts',
          action: 'gave-up',
        })
    },
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
  },
  {
    name: 'gave-up file with an empty patch: verification-failed',
    mutate: (i) => {
      alreadyCovered(i)
      if (i.report?.ok)
        i.report.report.files[0] = {
          path: 'backend/src/a.ts',
          action: 'gave-up',
        }
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /gave up.*backend\/src\/a\.ts/,
  },

  // --- R9: runtime weakening checks ---
  {
    name: 'R9: skipped test in a new file after the patch',
    mutate: (i) => {
      i.after!.backend.suite = run([...afterBackend, [A, 'a3', 'skipped']])
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /a\.test\.ts > a3 is skipped/,
  },
  {
    name: 'R9: todo test in a modified existing file after the patch',
    mutate: (i) => {
      i.after!.backend.suite = run([...afterBackend, [D, 'd4', 'todo']])
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /d\.test\.ts > d4 is todo/,
  },
  {
    name: 'R9: pending (non-terminal) status after the patch',
    mutate: (i) => {
      i.after!.frontend.suite = run([...frontendRows, [X, 'y', 'pending']])
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /x\.test\.tsx > y/,
  },
  {
    name: 'R9: skipped test in a stability run',
    mutate: (i) => {
      i.stability[0]!.tests.push({ name: 'a9', status: 'skipped' })
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /a\.test\.ts > a9 is skipped/,
  },
  {
    name: 'R9: a base-skipped test in a file the patch did not touch is ignored',
    mutate: () => {},
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
  },
  {
    name: 'R9: a base-skipped test in a file the patch modified still fails',
    mutate: (i) => {
      i.modifiedTestFiles = [D, LEGACY]
      i.stability.push({
        file: LEGACY,
        passedRuns: 3,
        tests: [{ name: 'old', status: 'skipped' }],
      })
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /legacy\.test\.ts > old is skipped after the patch/,
  },
  {
    name: 'R9: an untouched test newly skipped after the patch fails',
    mutate: (i) => {
      i.after!.backend.suite = run(
        afterBackend.map(([f, n, s]): Row => [f, n, f === B ? 'skipped' : s]),
      )
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /b\.test\.ts > covers b is skipped/,
  },
  {
    name: 'R9: passing count in a modified existing file drops',
    mutate: (i) => {
      i.after!.backend.suite = run([
        [B, 'covers b', 'passed'],
        [D, 'd1', 'passed'],
        [LEGACY, 'old', 'skipped'],
        [A, 'a1', 'passed'],
        [A, 'a2', 'passed'],
        [A, 'a3', 'passed'],
      ])
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /d\.test\.ts.*2.*1/,
  },
  {
    name: 'R9: modified test file without a stability run',
    mutate: (i) => {
      i.stability = i.stability.filter((s) => s.file !== D)
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /d\.test\.ts: no stability run/,
  },

  // --- controller rulings on the report ---
  {
    name: 'manifest file with no report entry: verification-failed',
    mutate: (i) => {
      if (i.report?.ok)
        i.report.report.files = i.report.report.files.filter(
          (f) => f.path !== 'backend/src/b.ts',
        )
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /no decision for backend\/src\/b\.ts/,
  },
  {
    name: 'report claims a test file the patch did not add or change',
    mutate: (i) => {
      if (i.report?.ok)
        i.report.report.files[0] = {
          path: 'backend/src/a.ts',
          action: 'create',
          testFile: 'backend/tests/phantom.test.ts',
        }
    },
    outcome: 'verification-failed',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /phantom\.test\.ts/,
  },
  {
    name: 'report entry for a file outside the manifest is ignored',
    mutate: (i) => {
      if (i.report?.ok)
        i.report.report.files.push({
          path: 'backend/src/other.ts',
          action: 'skip',
          skip: { file: B, testName: 'nope' },
        })
    },
    outcome: 'tests-added',
    conclusion: 'success',
    commitAllowed: true,
    reason: /ignored.*backend\/src\/other\.ts/,
  },
  {
    name: 'skip without any skip check: skip-unverified',
    mutate: (i) => {
      i.skipChecks = []
    },
    outcome: 'skip-unverified',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /backend\/src\/b\.ts/,
  },
  {
    name: 'skip check for another path does not verify the skip',
    mutate: (i) => {
      i.skipChecks = [{ path: 'backend/src/a.ts', ok: true, detail: '100%' }]
    },
    outcome: 'skip-unverified',
    conclusion: 'neutral',
    commitAllowed: false,
  },
  {
    name: 'excluded-from-coverage skip on a file not excluded on base',
    mutate: (i) => {
      i.plan.manifest[3]!.excludedOnBase = false
    },
    outcome: 'skip-unverified',
    conclusion: 'neutral',
    commitAllowed: false,
    reason: /frontend\/src\/c\.tsx.*excluded/,
  },
]

describe('computeVerdict', () => {
  it.each(cases)(
    '$name',
    ({ mutate, outcome, conclusion, commitAllowed, reason }) => {
      const i = inputs()
      mutate(i)
      const v = computeVerdict(deepFreeze(i))
      expect(v.outcome).toBe(outcome)
      expect(v.conclusion).toBe(conclusion)
      expect(v.commitAllowed).toBe(commitAllowed)
      expect(v.mode).toBe(i.plan.mode)
      if (reason) expect(v.reasons.join('\n')).toMatch(reason)
    },
  )

  it('is deterministic and does not mutate its inputs', () => {
    const i = inputs()
    withDefect(i)
    const before = structuredClone(i)
    const a = computeVerdict(i)
    const b = computeVerdict(i)
    expect(a).toEqual(b)
    expect(i).toEqual(before)
  })

  it('passes numbers, hash, banners and mode through from facts', () => {
    const i = inputs()
    i.plan.dependenciesChanged = true
    i.plan.testsRemovedByAuthor = [{ file: B, count: 2 }]
    const v = computeVerdict(i)
    expect(v.patchSha256).toBe('abc123')
    expect(v.numbers).toEqual(numbers())
    // An unknown coverage (pct null) stays null; it is never turned into a value.
    expect(v.numbers.backend.changedLines[1]!.before.pct).toBeNull()
    expect(v.banners).toEqual({
      dependenciesChanged: true,
      testsRemovedByAuthor: [{ file: B, count: 2 }],
      configChanged: false,
    })
  })

  it('sets the config-changed banner', () => {
    const i = inputs()
    i.plan.earlyOutcome = 'config-changed'
    expect(computeVerdict(i).banners.configChanged).toBe(true)
  })

  it('lists failing existing tests and typecheck per app on baseline-failing', () => {
    const i = inputs()
    i.baseline!.backend.typecheck = false
    i.baseline!.frontend.suite = run([[X, 'x', 'failed']])
    const v = computeVerdict(i)
    expect(v.outcome).toBe('baseline-failing')
    expect(v.baselineFailures).toEqual([
      { app: 'backend', tests: [], typecheck: true },
      { app: 'frontend', tests: [`${X} > x`], typecheck: false },
    ])
  })

  it('builds the files table from manifest, report and checks', () => {
    const i = inputs()
    withDefect(i)
    if (i.report?.ok)
      i.report.report.files.push(
        { path: 'backend/src/a.ts', action: 'gave-up' },
        {
          path: 'backend/src/unlisted.ts',
          action: 'create',
          testFile: 'backend/tests/unlisted.test.ts',
        },
      )
    const v = computeVerdict(i)
    expect(v.files).toEqual([
      { path: 'backend/src/a.ts', action: 'create', details: `${A}: 2 tests` },
      { path: 'backend/src/a.ts', action: 'gave up', details: '' },
      { path: 'backend/src/b.ts', action: 'skip', details: `${B} > covers b` },
      { path: 'backend/src/d.ts', action: 'update', details: `${D}: 3 tests` },
      {
        path: 'frontend/src/c.tsx',
        action: 'excluded from coverage',
        details: '',
      },
      {
        path: 'backend/src/a.ts',
        action: 'suspected defect',
        details: 'PR description: "must return 422 for empty titles"',
      },
    ])
  })

  it('shows a missing decision and an unverified skip in the files table', () => {
    const i = inputs()
    i.skipChecks = [{ path: 'backend/src/b.ts', ok: false, detail: '40%' }]
    if (i.report?.ok)
      i.report.report.files = i.report.report.files.filter(
        (f) => f.path !== 'backend/src/d.ts',
      )
    const v = computeVerdict(i)
    expect(v.files).toContainEqual({
      path: 'backend/src/d.ts',
      action: 'no decision',
      details: 'no decision for backend/src/d.ts',
    })
    expect(v.files).toContainEqual({
      path: 'backend/src/b.ts',
      action: 'skip',
      details: `${B} > covers b (unverified: 40%)`,
    })
  })

  it('lists accepted and rejected defects with citations', () => {
    const i = inputs()
    if (!i.report?.ok) throw new Error('fixture')
    i.report.report.defects = [
      defect(),
      {
        file: 'backend/src/d.ts',
        evidenceTest: 'backend/tests/__evidence__/d.test.ts',
        summary: 'wrong code',
        citation: { kind: 'openapi', pointer: '/paths/~1tasks/post' },
      },
      {
        file: 'backend/src/elsewhere.ts',
        evidenceTest: 'backend/tests/__evidence__/e.test.ts',
        summary: 'not in this PR',
        citation: { kind: 'openapi', pointer: '/x' },
      },
    ]
    i.evidence = [
      goodEvidence(),
      {
        file: 'backend/tests/__evidence__/d.test.ts',
        failuresOnHead: 3,
        allAssertion: false,
        citationOk: true,
      },
      { ...goodEvidence(), file: 'backend/tests/__evidence__/e.test.ts' },
    ]
    const v = computeVerdict(i)
    expect(v.outcome).toBe('defect')
    expect(v.defects).toEqual([
      {
        file: 'backend/src/a.ts',
        evidenceTest: EVIDENCE,
        citation: 'PR description: "must return 422 for empty titles"',
        accepted: true,
      },
      {
        file: 'backend/src/d.ts',
        evidenceTest: 'backend/tests/__evidence__/d.test.ts',
        citation: 'openapi.json /paths/~1tasks/post',
        accepted: false,
        rejectReason: expect.stringMatching(/assertion/),
      },
      {
        file: 'backend/src/elsewhere.ts',
        evidenceTest: 'backend/tests/__evidence__/e.test.ts',
        citation: 'openapi.json /x',
        accepted: false,
        rejectReason: expect.stringMatching(/manifest/),
      },
    ])
  })

  it('lists the defect in backfill mode without changing the outcome', () => {
    const i = inputs()
    i.plan.mode = 'backfill'
    withDefect(i)
    const v = computeVerdict(i)
    expect(v.outcome).toBe('tests-added')
    expect(v.defects).toMatchObject([{ accepted: true }])
    expect(v.files.at(-1)).toMatchObject({ action: 'suspected defect' })
  })

  it('marks defects as not evaluated when the run stopped before verification', () => {
    const i = inputs()
    withDefect(i)
    i.unguardedToolUses = ['toolu_1']
    const v = computeVerdict(i)
    expect(v.defects).toMatchObject([
      { accepted: false, rejectReason: expect.stringMatching(/not evaluated/) },
    ])
  })
})

describe('conclusionFor', () => {
  const table: [Outcome, Mode, Conclusion | 'unaffected'][] = [
    ['tests-added', 'pr', 'success'],
    ['already-covered', 'pr', 'success'],
    ['nothing-to-test', 'pr', 'success'],
    ['draft', 'pr', 'neutral'],
    ['config-changed', 'pr', 'neutral'],
    ['budget-exhausted', 'pr', 'neutral'],
    ['timeout', 'pr', 'neutral'],
    ['patch-rejected', 'pr', 'neutral'],
    ['verification-failed', 'pr', 'neutral'],
    ['skip-unverified', 'pr', 'neutral'],
    ['discovery-mismatch', 'pr', 'neutral'],
    ['agent-run-invalid', 'pr', 'neutral'],
    ['baseline-failing', 'pr', 'neutral'],
    ['head-moved', 'pr', 'neutral'],
    ['pipeline-error', 'pr', 'neutral'],
    ['defect', 'pr', 'failure'],
    ['defect-dismissed', 'pr', 'neutral'],
    ['defect', 'backfill', 'unaffected'],
    ['tests-added', 'backfill', 'success'],
    ['verification-failed', 'backfill', 'neutral'],
  ]
  it.each(table)('%s in %s mode → %s', (outcome, mode, expected) => {
    expect(conclusionFor(outcome, mode)).toBe(expected)
  })
})
