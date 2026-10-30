import { dismissComment, outcomeFromComment, verdictLine } from './comment.ts'
import { decideDismiss, DISMISS_LABEL } from './filter.ts'
import {
  createCheckRun,
  findOwnComment,
  getPermission,
  getPull,
  latestCheckRun,
  removeLabel,
  upsertComment,
  type GitHub,
  type Repo,
} from './github.ts'
import type { Conclusion } from './types.ts'

export interface DismissArgs {
  prNumber: number
  /** `workflow_run.triggering_actor` (trusted event data, never the artifact). */
  labeler: string
  botLogin: string
  /** Our GitHub App id: only its check runs count. */
  appId: number
  runUrl: string
}

const CONCLUSIONS = new Set(['success', 'neutral', 'failure'])

/**
 * Spec §6.6: flips the current head's defect `failure` to `neutral` when a non-author with
 * write permission added the dismiss label; otherwise notes in the comment why it was ignored.
 * Uses only the GitHub API; no PR code is checked out or run.
 */
export async function runDismiss(
  args: DismissArgs,
  deps: { octokit: GitHub; repo: Repo; log?: (line: string) => void },
): Promise<{ apply: boolean; reason: string }> {
  const { octokit: o, repo } = deps
  const pr = await getPull(o, repo, args.prNumber)
  if (pr === null) throw new Error(`pull request ${args.prNumber} not found`)
  const headSha = pr.head.sha
  const [permission, check, comment] = await Promise.all([
    getPermission(o, repo, args.labeler),
    latestCheckRun(o, repo, headSha, args.appId),
    findOwnComment(o, repo, args.prNumber, args.botLogin),
  ])
  const conclusion =
    check?.conclusion && CONCLUSIONS.has(check.conclusion)
      ? (check.conclusion as Conclusion)
      : null
  const decision = decideDismiss({
    labeler: args.labeler,
    prAuthor: pr.user?.login ?? '',
    permission,
    currentCheckConclusion: conclusion,
    currentOutcome: comment ? outcomeFromComment(comment.body) : null,
  })
  if (decision.apply) {
    const note = `Defect dismissed by ${args.labeler}.`
    await createCheckRun(
      o,
      repo,
      headSha,
      'neutral',
      verdictLine('defect-dismissed'),
      note,
      args.runUrl,
    )
    await upsertComment(
      o,
      repo,
      args.prNumber,
      dismissComment(comment?.body ?? null, note, true),
      args.botLogin,
    )
  } else {
    await upsertComment(
      o,
      repo,
      args.prNumber,
      dismissComment(
        comment?.body ?? null,
        `The dismissal by ${args.labeler} was ignored: ${decision.reason}.`,
        false,
      ),
      args.botLogin,
    )
  }
  // The label is consumed either way, so it can be added again later.
  await removeLabel(o, repo, args.prNumber, DISMISS_LABEL)
  deps.log?.(
    `dismiss: ${decision.apply ? 'applied' : 'ignored'} (${decision.reason})`,
  )
  return decision
}
