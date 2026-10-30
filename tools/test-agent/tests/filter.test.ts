import { describe, expect, it } from 'vitest'
import {
  decideDismiss,
  decideTrigger,
  hasRunTrailer,
  type TriggerInput,
} from '../src/filter.ts'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const BOT = 'taskly-test-agent[bot]'

const input = (over: Partial<TriggerInput> = {}): TriggerInput => ({
  trigger: { prNumber: 7, headSha: SHA, action: 'synchronize' },
  workflowRun: { headSha: SHA, triggeringActor: 'alice' },
  pr: {
    headSha: SHA,
    headRepo: 'acme/taskly',
    baseRepo: 'acme/taskly',
    draft: false,
    labels: [],
    author: 'alice',
  },
  headCommitMessage: 'feat: add count route',
  botLogin: BOT,
  ...over,
})

const pr = (over: Partial<NonNullable<TriggerInput['pr']>>) => ({
  ...input().pr!,
  ...over,
})

const TRAILER_MSG = 'test(agent): add unit tests for #7\n\nTest-Agent-Run: 123'

describe('decideTrigger', () => {
  it('runs the pipeline for a normal push', () => {
    expect(decideTrigger(input())).toMatchObject({
      path: 'pipeline',
      budgetProfile: 'default',
    })
  })

  it('stops when the pull request is missing', () => {
    expect(decideTrigger(input({ pr: null })).path).toBe('stop')
  })

  it('stops when the PR head differs from the trigger artifact', () => {
    expect(decideTrigger(input({ pr: pr({ headSha: OTHER }) }))).toMatchObject({
      path: 'stop',
    })
  })

  it('stops when workflow_run.head_sha differs from the PR head', () => {
    expect(
      decideTrigger(
        input({ workflowRun: { headSha: OTHER, triggeringActor: 'alice' } }),
      ).path,
    ).toBe('stop')
  })

  it('stops for forks', () => {
    expect(
      decideTrigger(input({ pr: pr({ headRepo: 'mallory/taskly' }) })).path,
    ).toBe('stop')
  })

  it('stops for an authentic trailer commit pushed by the bot', () => {
    expect(
      decideTrigger(
        input({
          headCommitMessage: TRAILER_MSG,
          workflowRun: { headSha: SHA, triggeringActor: BOT },
        }),
      ).path,
    ).toBe('stop')
  })

  it('compares the bot login case-insensitively', () => {
    expect(
      decideTrigger(
        input({
          headCommitMessage: TRAILER_MSG,
          workflowRun: { headSha: SHA, triggeringActor: BOT.toUpperCase() },
        }),
      ).path,
    ).toBe('stop')
  })

  it('runs normally when a human pushes a commit with a forged trailer', () => {
    expect(
      decideTrigger(input({ headCommitMessage: TRAILER_MSG })),
    ).toMatchObject({ path: 'pipeline', budgetProfile: 'default' })
  })

  it('runs normally when the bot is the actor but the trailer is missing', () => {
    expect(
      decideTrigger(
        input({ workflowRun: { headSha: SHA, triggeringActor: BOT } }),
      ).path,
    ).toBe('pipeline')
  })

  it.each(['opened', 'reopened', 'ready_for_review', 'synchronize'])(
    'runs the pipeline on %s',
    (action) => {
      expect(
        decideTrigger(input({ trigger: { prNumber: 7, headSha: SHA, action } }))
          .path,
      ).toBe('pipeline')
    },
  )

  it('runs the pipeline for drafts (plan reports the draft outcome)', () => {
    expect(decideTrigger(input({ pr: pr({ draft: true }) })).path).toBe(
      'pipeline',
    )
  })

  it('stops on unknown actions', () => {
    expect(
      decideTrigger(
        input({ trigger: { prNumber: 7, headSha: SHA, action: 'closed' } }),
      ).path,
    ).toBe('stop')
  })

  it('runs the large profile on labeled test-agent:retry-large', () => {
    expect(
      decideTrigger(
        input({
          trigger: {
            prNumber: 7,
            headSha: SHA,
            action: 'labeled',
            label: 'test-agent:retry-large',
          },
          pr: pr({ labels: ['test-agent:retry-large'] }),
        }),
      ),
    ).toMatchObject({ path: 'pipeline', budgetProfile: 'large' })
  })

  it('stops on any other label', () => {
    expect(
      decideTrigger(
        input({
          trigger: {
            prNumber: 7,
            headSha: SHA,
            action: 'labeled',
            label: 'bug',
          },
          pr: pr({ labels: ['bug'] }),
        }),
      ).path,
    ).toBe('stop')
  })

  it('takes the dismiss path on labeled test-agent:dismiss', () => {
    expect(
      decideTrigger(
        input({
          trigger: {
            prNumber: 7,
            headSha: SHA,
            action: 'labeled',
            label: 'test-agent:dismiss',
          },
          pr: pr({ labels: ['test-agent:dismiss'] }),
          workflowRun: { headSha: SHA, triggeringActor: 'bob' },
        }),
      ).path,
    ).toBe('dismiss')
  })

  it('stops when the claimed label is not on the PR (artifact is untrusted)', () => {
    expect(
      decideTrigger(
        input({
          trigger: {
            prNumber: 7,
            headSha: SHA,
            action: 'labeled',
            label: 'test-agent:retry-large',
          },
        }),
      ).path,
    ).toBe('stop')
  })

  it('stops on labeled without a label name', () => {
    expect(
      decideTrigger(
        input({ trigger: { prNumber: 7, headSha: SHA, action: 'labeled' } }),
      ).path,
    ).toBe('stop')
  })
})

describe('hasRunTrailer', () => {
  it('finds the trailer line', () => {
    expect(hasRunTrailer(TRAILER_MSG)).toBe(true)
    expect(hasRunTrailer('x\r\n\r\nTest-Agent-Run: 9\r\n')).toBe(true)
  })

  it('ignores mentions that are not a trailer line', () => {
    expect(hasRunTrailer('mentions Test-Agent-Run: 1 inline')).toBe(false)
    expect(hasRunTrailer('Test-Agent-Run:')).toBe(false)
  })
})

describe('decideDismiss', () => {
  const ok = {
    labeler: 'bob',
    prAuthor: 'alice',
    permission: 'write',
    currentCheckConclusion: 'failure' as const,
    currentOutcome: 'defect' as const,
  }

  it('applies for a writer who is not the author on a defect failure', () => {
    expect(decideDismiss(ok).apply).toBe(true)
  })

  it.each(['maintain', 'admin'])('accepts permission %s', (permission) => {
    expect(decideDismiss({ ...ok, permission }).apply).toBe(true)
  })

  it('refuses the PR author', () => {
    const d = decideDismiss({ ...ok, labeler: 'Alice' })
    expect(d.apply).toBe(false)
    expect(d.reason).toMatch(/author/)
  })

  it.each(['read', 'triage', 'none', ''])('refuses permission %j', (p) => {
    expect(decideDismiss({ ...ok, permission: p }).apply).toBe(false)
  })

  it('refuses without a current defect failure', () => {
    expect(
      decideDismiss({ ...ok, currentCheckConclusion: 'neutral' }).apply,
    ).toBe(false)
    expect(decideDismiss({ ...ok, currentCheckConclusion: null }).apply).toBe(
      false,
    )
    expect(
      decideDismiss({ ...ok, currentOutcome: 'verification-failed' }).apply,
    ).toBe(false)
    expect(decideDismiss({ ...ok, currentOutcome: null }).apply).toBe(false)
  })
})
