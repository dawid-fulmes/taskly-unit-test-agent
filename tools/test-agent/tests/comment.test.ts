import { describe, expect, it } from 'vitest'
import {
  COMMENT_MARKER,
  escapeModelText,
  renderComment,
  renderDismissNote,
  type RunMeta,
} from '../src/comment.ts'
import type { Report } from '../src/report.ts'
import type { Outcome } from '../src/types.ts'
import type { AppNumbers, Verdict } from '../src/verdict.ts'

const ZWJ = '‍'
const HOSTILE =
  '@org/team </details><img src=x onerror=1> ``` <!-- test-agent:report -->'

const appNumbers = (): AppNumbers => ({
  typecheckBefore: true,
  typecheckAfter: true,
  suiteBefore: { passed: 3, total: 3 },
  suiteAfter: { passed: 5, total: 5 },
  stability: { passedRuns: 3, runs: 3 },
  changedLines: [
    {
      file: 'backend/src/a.ts',
      before: { status: 'measured', covered: 0, total: 4, pct: 0 },
      after: { status: 'measured', covered: 4, total: 4, pct: 1 },
    },
    {
      file: 'backend/src/e.ts',
      before: { status: 'missing', covered: 0, total: 0, pct: 0 },
      after: { status: 'missing', covered: 0, total: 0, pct: 0 },
    },
  ],
  appLines: null,
})

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  mode: 'pr',
  outcome: 'tests-added',
  conclusion: 'success',
  commitAllowed: true,
  patchSha256: null,
  reasons: [],
  files: [
    {
      path: 'backend/src/a.ts',
      action: 'create',
      details: 'backend/tests/a.test.ts: 2 tests',
    },
  ],
  defects: [],
  numbers: {
    backend: appNumbers(),
    frontend: {
      ...appNumbers(),
      suiteBefore: { passed: 0, total: 0 },
      suiteAfter: null,
      stability: null,
      changedLines: [],
    },
  },
  banners: {
    dependenciesChanged: false,
    testsRemovedByAuthor: [],
    configChanged: false,
  },
  baselineFailures: [],
  ...over,
})

const report = (over: Partial<Report> = {}): Report => ({
  files: [],
  behaviours: [
    {
      file: 'backend/src/a.ts',
      description: 'returns 422 for empty titles',
      source: { kind: 'pr-description', ref: 'PR body' },
    },
  ],
  defects: [],
  narrative: 'Looked at the code.',
  ...over,
})

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  runUrl: 'https://github.com/o/r/actions/runs/1',
  model: 'claude-sonnet-5-5',
  budgetProfile: 'default',
  skills: ['unit-test-writer'],
  turns: 12,
  costUsd: 0.456,
  ...over,
})

const count = (s: string, sub: string) => s.split(sub).length - 1

describe('escapeModelText', () => {
  it('neutralises html, mentions, backticks, pipes and newlines', () => {
    const out = escapeModelText('a|b\n@x `c` <b> & "q"')
    expect(out).toBe(`a\\|b @${ZWJ}x \\\`c\\\` &lt;b&gt; &amp; &quot;q&quot;`)
  })

  it('does not let a backslash re-open a backtick', () => {
    expect(escapeModelText('\\`')).toBe('\\\\\\`')
  })
})

describe('hostile model text (Review Focus 4)', () => {
  it('renders narrative, behaviours, summaries and evidence inert with one marker', () => {
    const v = verdict({
      outcome: 'defect',
      conclusion: 'failure',
      defects: [
        {
          file: 'backend/src/a.ts',
          evidenceTest: 'backend/tests/__evidence__/a.test.ts',
          citation: 'openapi.json /paths/~1x',
          accepted: true,
        },
      ],
    })
    const r = report({
      narrative: HOSTILE,
      behaviours: [
        {
          file: 'backend/src/a.ts',
          description: HOSTILE,
          source: { kind: 'type', ref: HOSTILE },
        },
      ],
      defects: [
        {
          file: 'backend/src/a.ts',
          evidenceTest: 'backend/tests/__evidence__/a.test.ts',
          summary: HOSTILE,
          citation: { kind: 'openapi', pointer: '/paths/~1x' },
        },
      ],
    })
    const out = renderComment(v, r, meta(), {
      'backend/tests/__evidence__/a.test.ts': `// @org/team <!-- test-agent:report -->\n\`\`\`\`\n</details>\n`,
    })
    expect(out).toContain(`@${ZWJ}org`)
    expect(out).not.toMatch(/@(?!‍)/)
    // Inside code fences HTML is inert; outside them it must be escaped.
    expect(out.replace(/(`{3,})[\s\S]*?\n\1/g, '')).not.toContain('<img')
    expect(count(out, '<details>')).toBe(count(out, '</details>'))
    expect(count(out, '</details>')).toBe(2) // defect + narrative
    expect(count(out, COMMENT_MARKER)).toBe(1)
    expect(out.startsWith(`${COMMENT_MARKER}\n`)).toBe(true)
  })

  it('uses a fence longer than any backtick run in the narrative', () => {
    const out = renderComment(
      verdict(),
      report({ narrative: 'x ````` y' }),
      meta(),
    )
    expect(out).toContain('\n``````text\n')
  })
})

describe('autolinks, invisibles and fences', () => {
  it('breaks issue refs, URLs, SHAs and emoji codes', () => {
    const out = escapeModelText(
      'fixes #123 org/repo#45 GH-9 https://evil.example/x deadbeefcafe :shipit:',
    )
    expect(out).not.toMatch(/#\d/)
    expect(out).not.toContain('://')
    expect(out).not.toContain('GH-9')
    expect(out).not.toContain('deadbeefcafe')
    expect(out).not.toContain(':shipit:')
    expect(out).toContain(`#${ZWJ}123`)
    expect(out).toContain(`org/repo#${ZWJ}45`)
    expect(out).toContain(`:/${ZWJ}/evil`)
    expect(out).toContain(`deadbe${ZWJ}efcafe`)
    expect(out).toContain(`:${ZWJ}shipit:`)
  })

  it('strips bidi and invisible controls before neutralising', () => {
    const out = escapeModelText('a\u202Eb\u200Bc\uFEFF\u2066d @x')
    expect(out).toBe(`abcd @${ZWJ}x`)
  })

  it('keeps narrative text raw inside the fence but neutral', () => {
    const out = renderComment(
      verdict(),
      report({
        narrative: 'a & b <DETAILS> ~~~\n@bob <!-- test-agent:report -->\u202E',
      }),
      meta(),
    )
    expect(out).toContain('a & b')
    expect(out).not.toContain('<DETAILS>')
    expect(out).not.toContain('\u202E')
    expect(out).toContain(`@${ZWJ}bob`)
    expect(count(out, COMMENT_MARKER)).toBe(1)
    expect(count(out, '<details>')).toBe(count(out, '</details>'))
  })

  it('caps table cells at 500 chars', () => {
    const out = renderComment(
      verdict({
        files: [
          {
            path: 'backend/src/a.ts',
            action: 'skip',
            details: 'z'.repeat(900),
          },
        ],
      }),
      report(),
      meta(),
    )
    expect(out).not.toContain('z'.repeat(501))
    expect(out).toContain('z'.repeat(499) + '…')
  })
})

describe('summary autolinks', () => {
  it('breaks issue refs in defect summaries', () => {
    const out = renderComment(
      verdict({
        outcome: 'defect',
        conclusion: 'failure',
        defects: [
          {
            file: 'x #123 org/repo#45 https://e.example',
            evidenceTest: 'backend/tests/__evidence__/a.test.ts',
            citation: 'c',
            accepted: true,
          },
        ],
      }),
      report(),
      meta(),
    )
    const summary = out
      .split('\n')
      .find((l) => l.includes('Suspected defect:'))!
    expect(summary).not.toMatch(/#\d/)
    expect(summary).not.toContain('://')
    expect(summary).toContain(`#${ZWJ}123`)
    expect(summary).toContain(`org/repo#${ZWJ}45`)
  })
})

describe('verdict lines', () => {
  const outcomes: Outcome[] = [
    'tests-added',
    'already-covered',
    'nothing-to-test',
    'draft',
    'config-changed',
    'budget-exhausted',
    'timeout',
    'patch-rejected',
    'verification-failed',
    'skip-unverified',
    'discovery-mismatch',
    'agent-run-invalid',
    'baseline-failing',
    'head-moved',
    'pipeline-error',
    'defect',
    'defect-dismissed',
  ]
  const lineFor = (o: Outcome) =>
    renderComment(verdict({ outcome: o }), report(), meta()).split('\n')[2]!

  it('renders a distinct line per outcome with the right symbol', () => {
    const lines = outcomes.map(lineFor)
    expect(new Set(lines).size).toBe(outcomes.length)
    for (const o of outcomes) {
      const expected =
        o === 'defect'
          ? '❌'
          : ['tests-added', 'already-covered', 'nothing-to-test'].includes(o)
            ? '✅'
            : '⚪'
      expect(lineFor(o).startsWith(`## ${expected}`)).toBe(true)
    }
  })

  it('adds the retry-large hint only for agent-side neutral outcomes', () => {
    const hinted = [
      'budget-exhausted',
      'timeout',
      'patch-rejected',
      'verification-failed',
      'skip-unverified',
    ]
    for (const o of outcomes) {
      const out = renderComment(verdict({ outcome: o }), report(), meta())
      expect(out.includes('test-agent:retry-large')).toBe(hinted.includes(o))
    }
  })
})

describe('sections', () => {
  it('lists failing baseline tests per app with the author notice', () => {
    const out = renderComment(
      verdict({
        outcome: 'baseline-failing',
        conclusion: 'neutral',
        baselineFailures: [
          {
            app: 'backend',
            tests: ['backend/tests/x.test.ts > breaks | here'],
            typecheck: true,
          },
        ],
      }),
      report(),
      meta(),
    )
    expect(out).toContain('**backend**')
    expect(out).toContain('backend/tests/x.test.ts &gt; breaks \\| here')
    expect(out).toContain('typecheck fails')
    expect(out).toContain(
      'These existing tests fail on the PR head before any agent change. The author must fix them; the agent never edits existing assertions.',
    )
  })

  it('renders banners', () => {
    const out = renderComment(
      verdict({
        banners: {
          dependenciesChanged: true,
          testsRemovedByAuthor: [
            { file: 'backend/tests/old.test.ts', count: 2 },
          ],
          configChanged: true,
        },
      }),
      report(),
      meta(),
    )
    expect(out).toContain('Dependencies changed')
    expect(out).toContain('Tests removed by the author:** 2')
    expect(out).toContain('backend/tests/old.test.ts (2)')
    expect(out).toContain('Config changed')
  })

  it('renders missing, excluded, unknown and absent coverage distinctly', () => {
    const v = verdict()
    v.numbers.backend.changedLines.push(
      {
        file: 'backend/src/x.ts',
        before: { status: 'excluded', covered: 0, total: 0, pct: null },
        after: null,
      },
      {
        file: 'backend/src/u.ts',
        before: { status: 'measured', covered: 0, total: 0, pct: null },
        after: null,
      },
    )
    const out = renderComment(v, report(), meta())
    expect(out).toContain(
      '| backend/src/e.ts | 0% (not in coverage report) → 0% (not in coverage report) |',
    )
    expect(out).toContain('| backend/src/x.ts | excluded from coverage → n/a |')
    expect(out).toContain('| backend/src/u.ts | n/a → n/a |')
    expect(out).toContain('| backend/src/a.ts | 0% (0/4) → 100% (4/4) |')
  })

  it('shows backfill app-wide line coverage before and after', () => {
    const v = verdict({ mode: 'backfill' })
    v.numbers.backend.appLines = { before: 0.5, after: 0.912 }
    v.numbers.frontend.appLines = { before: 0.4, after: null }
    const out = renderComment(v, report(), meta())
    expect(out).toContain('**backend app-wide line coverage:** 50% → 91.2%')
    expect(out).toContain('**frontend app-wide line coverage:** 40% → n/a')
  })

  it('renders run metadata as facts, null as n/a', () => {
    const out = renderComment(verdict(), report(), meta())
    expect(out).toContain('- Skills used: unit-test-writer')
    expect(out).toContain('- Turns: 12')
    expect(out).toContain('- Cost: $0.46')
    const na = renderComment(
      verdict(),
      report(),
      meta({ skills: null, turns: null, costUsd: null }),
    )
    expect(na).toContain('- Skills used: n/a')
    expect(na).toContain('- Turns: n/a')
    expect(na).toContain('- Cost: n/a')
  })

  it('renders defects with citation and evidence source in a fence', () => {
    const out = renderComment(
      verdict({
        outcome: 'defect',
        conclusion: 'failure',
        defects: [
          {
            file: 'backend/src/a.ts',
            evidenceTest: 'backend/tests/__evidence__/a.test.ts',
            citation: 'openapi.json /paths/~1x',
            accepted: true,
          },
        ],
      }),
      report(),
      meta(),
      { 'backend/tests/__evidence__/a.test.ts': 'expect(1).toBe(2)' },
    )
    expect(out).toContain(
      '**Citation:** openapi.json /paths/\\~1x'.replace('\\~', '~'),
    )
    expect(out).toContain('```ts\nexpect(1).toBe(2)\n```')
  })

  it('renders without a report (early outcome)', () => {
    const out = renderComment(
      verdict({ outcome: 'draft', conclusion: 'neutral' }),
      null,
      meta(),
    )
    expect(out).not.toContain('Model narrative')
    expect(count(out, COMMENT_MARKER)).toBe(1)
  })
})

describe('size limits', () => {
  it('caps behaviours at 50 rows', () => {
    const behaviours = Array.from({ length: 60 }, (_, i) => ({
      file: 'backend/src/a.ts',
      description: `b${i}`,
      source: { kind: 'type' as const, ref: 'r' },
    }))
    const out = renderComment(verdict(), report({ behaviours }), meta())
    expect(out).toContain('…and 10 more')
    expect(out).not.toContain('b50')
  })

  it('truncates the narrative and the evidence source', () => {
    const out = renderComment(
      verdict({
        defects: [
          {
            file: 'backend/src/a.ts',
            evidenceTest: 'backend/tests/__evidence__/a.test.ts',
            citation: 'c',
            accepted: true,
          },
        ],
      }),
      report({ narrative: 'n'.repeat(10000) }),
      meta(),
      { 'backend/tests/__evidence__/a.test.ts': 'e'.repeat(20000) },
    )
    expect(out).not.toContain('n'.repeat(4001))
    expect(out).not.toContain('e'.repeat(8001))
    expect(out).toContain('…(truncated)')
  })

  it('stays under 65536 chars, dropping narrative then evidence then behaviours', () => {
    const defects = Array.from({ length: 12 }, (_, i) => ({
      file: 'backend/src/a.ts',
      evidenceTest: `backend/tests/__evidence__/e${i}.test.ts`,
      citation: 'c',
      accepted: true,
    }))
    const evidence = Object.fromEntries(
      defects.map((d) => [d.evidenceTest, 'e'.repeat(8000)]),
    )
    const out = renderComment(
      verdict({ outcome: 'defect', conclusion: 'failure', defects }),
      report({ narrative: 'n'.repeat(4000) }),
      meta(),
      evidence,
    )
    expect(out.length).toBeLessThan(65536)
    expect(out).toContain('Omitted to fit')
    expect(out).toContain('model narrative')
    expect(out).toContain('evidence test sources')
    expect(count(out, '<details>')).toBe(count(out, '</details>'))
  })
})

describe('renderDismissNote', () => {
  it('escapes the text', () => {
    const note = renderDismissNote('by @bob <script>')
    expect(note).toContain(`@${ZWJ}bob`)
    expect(note).not.toContain('<script>')
  })
})
