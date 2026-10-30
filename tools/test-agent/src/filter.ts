import type { Conclusion, Outcome } from './types.ts'

export const RETRY_LARGE_LABEL = 'test-agent:retry-large'
export const DISMISS_LABEL = 'test-agent:dismiss'

/** Actions that (re)analyse the head; drafts go on so plan can report the `draft` outcome. */
const RUN_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'ready_for_review',
])

export interface TriggerInput {
  /** From the untrusted `trigger.json` artifact. */
  trigger: { prNumber: number; headSha: string; action: string; label?: string }
  /** From the `workflow_run` event (trusted). */
  workflowRun: { headSha: string; triggeringActor: string }
  /** From the API; null when the PR does not exist. */
  pr: {
    headSha: string
    headRepo: string
    baseRepo: string
    draft: boolean
    labels: string[]
    author: string
  } | null
  headCommitMessage: string
  botLogin: string
}

export interface TriggerDecision {
  path: 'pipeline' | 'dismiss' | 'stop'
  reason: string
  budgetProfile: 'default' | 'large'
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** A `Test-Agent-Run: <id>` line anywhere in the message (ADR 0016). */
export function hasRunTrailer(message: string): boolean {
  return /^Test-Agent-Run:[ \t]*\S+[ \t]*$/m.test(
    message.replace(/\r\n/g, '\n'),
  )
}

/**
 * Spec §6.1 / ADR 0020: decides from trusted event data and the API whether this trigger runs
 * the pipeline, the dismiss path or nothing. The artifact is only a claim checked against both.
 */
export function decideTrigger(i: TriggerInput): TriggerDecision {
  const stop = (reason: string): TriggerDecision => ({
    path: 'stop',
    reason,
    budgetProfile: 'default',
  })
  const { pr, trigger } = i
  if (pr === null) return stop('pull request not found')
  if (pr.headSha !== trigger.headSha)
    return stop('PR head differs from the trigger artifact')
  if (i.workflowRun.headSha !== pr.headSha)
    return stop('PR head differs from workflow_run.head_sha')
  if (pr.headRepo !== pr.baseRepo)
    return stop('fork pull requests are disabled')
  if (
    i.botLogin !== '' &&
    sameLogin(i.workflowRun.triggeringActor, i.botLogin) &&
    hasRunTrailer(i.headCommitMessage)
  )
    return stop('authentic test-agent commit (bot actor and trailer)')

  if (trigger.action === 'labeled') {
    const label = trigger.label
    if (label === undefined) return stop('labeled event without a label')
    if (label !== RETRY_LARGE_LABEL && label !== DISMISS_LABEL)
      return stop('label is not a test-agent label')
    // The artifact is untrusted: the label must really be on the PR.
    if (!pr.labels.includes(label)) return stop('label is not on the PR')
    if (label === DISMISS_LABEL)
      return {
        path: 'dismiss',
        reason: 'dismiss label',
        budgetProfile: 'default',
      }
    return {
      path: 'pipeline',
      reason: 'retry with the large budget',
      budgetProfile: 'large',
    }
  }
  if (RUN_ACTIONS.has(trigger.action))
    return {
      path: 'pipeline',
      reason: trigger.action,
      budgetProfile: 'default',
    }
  return stop('action not handled')
}

const WRITE_PERMISSIONS = new Set(['write', 'maintain', 'admin'])

/** Spec §6.6 / ADR 0014: who may flip a defect failure to neutral. */
export function decideDismiss(i: {
  labeler: string
  prAuthor: string
  permission: string
  currentCheckConclusion: Conclusion | null
  currentOutcome: Outcome | null
}): { apply: boolean; reason: string } {
  if (sameLogin(i.labeler, i.prAuthor))
    return { apply: false, reason: 'the labeler is the PR author' }
  if (!WRITE_PERMISSIONS.has(i.permission))
    return {
      apply: false,
      reason: 'the labeler does not have write permission',
    }
  if (i.currentCheckConclusion !== 'failure' || i.currentOutcome !== 'defect')
    return {
      apply: false,
      reason: 'the current head has no suspected defect failure',
    }
  return { apply: true, reason: 'dismissed' }
}
