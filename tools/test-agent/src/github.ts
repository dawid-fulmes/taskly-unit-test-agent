import { COMMENT_MARKER } from './comment.ts'
import type { Conclusion } from './types.ts'

export const CHECK_NAME = 'test-agent/verified'

// A type alias (not an interface) so it is assignable to Octokit's indexed request parameters.
export type Repo = {
  owner: string
  repo: string
}

export interface PullData {
  number: number
  draft?: boolean
  head: { sha: string; ref: string; repo: { full_name: string } | null }
  base: { ref: string; repo: { full_name: string } }
  labels: { name?: string }[]
  user: { login: string } | null
}

/**
 * The subset of `@octokit/rest` the tooling uses. A real `Octokit` satisfies it (checked in the
 * CLIs); tests pass in-memory fakes. Every GitHub call goes through the helpers below.
 */
export interface GitHub {
  rest: {
    issues: {
      listComments(
        p: Repo & { issue_number: number; per_page?: number; page?: number },
      ): Promise<{
        data: {
          id: number
          body?: string | null
          user: { login: string } | null
        }[]
      }>
      createComment(
        p: Repo & { issue_number: number; body: string },
      ): Promise<unknown>
      updateComment(
        p: Repo & { comment_id: number; body: string },
      ): Promise<unknown>
      removeLabel(
        p: Repo & { issue_number: number; name: string },
      ): Promise<unknown>
    }
    checks: {
      create(
        p: Repo & {
          name: string
          head_sha: string
          status: 'completed'
          conclusion: Conclusion
          completed_at: string
          details_url: string
          output: { title: string; summary: string }
        },
      ): Promise<{ data: { id: number } }>
      listForRef(
        p: Repo & {
          ref: string
          check_name: string
          app_id?: number
          filter?: 'latest' | 'all'
          per_page?: number
        },
      ): Promise<{
        data: {
          check_runs: {
            id: number
            name: string
            conclusion: string | null
            app: { id: number } | null
          }[]
        }
      }>
    }
    pulls: {
      create(
        p: Repo & { head: string; base: string; title: string; body: string },
      ): Promise<{ data: { number: number } }>
      get(p: Repo & { pull_number: number }): Promise<{ data: PullData }>
      list(
        p: Repo & { head?: string; state?: 'open'; per_page?: number },
      ): Promise<{ data: { number: number }[] }>
    }
    repos: {
      getCollaboratorPermissionLevel(
        p: Repo & { username: string },
      ): Promise<{ data: { permission: string } }>
    }
    git: {
      getCommit(
        p: Repo & { commit_sha: string },
      ): Promise<{ data: { message: string } }>
    }
  }
}

export function httpStatus(error: unknown): number | null {
  const s = (error as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : null
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const PAGE = 100
const MAX_PAGES = 50

/** Our sticky comment: written by the bot login and starting with the marker. Never a human's. */
export async function findOwnComment(
  o: GitHub,
  repo: Repo,
  pr: number,
  botLogin: string,
): Promise<{ id: number; body: string } | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await o.rest.issues.listComments({
      ...repo,
      issue_number: pr,
      per_page: PAGE,
      page,
    })
    for (const c of data) {
      const body = c.body ?? ''
      if (
        c.user !== null &&
        sameLogin(c.user.login, botLogin) &&
        body.startsWith(COMMENT_MARKER)
      )
        return { id: c.id, body }
    }
    if (data.length < PAGE) break
  }
  return null
}

/**
 * Updates our sticky comment or creates it. `keep` may veto replacing an existing comment
 * (e.g. one written by a newer run); returns false when nothing was written.
 */
export async function upsertComment(
  o: GitHub,
  repo: Repo,
  pr: number,
  body: string,
  botLogin: string,
  keep?: (existingBody: string) => Promise<boolean>,
): Promise<boolean> {
  const own = await findOwnComment(o, repo, pr, botLogin)
  if (own) {
    if (keep && (await keep(own.body))) return false
    await o.rest.issues.updateComment({ ...repo, comment_id: own.id, body })
  } else await o.rest.issues.createComment({ ...repo, issue_number: pr, body })
  return true
}

export async function createCheckRun(
  o: GitHub,
  repo: Repo,
  headSha: string,
  conclusion: Conclusion,
  title: string,
  summary: string,
  detailsUrl: string,
): Promise<void> {
  await o.rest.checks.create({
    ...repo,
    name: CHECK_NAME,
    head_sha: headSha,
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    details_url: detailsUrl,
    output: { title, summary },
  })
}

/** The newest `test-agent/verified` check run on `sha` created by our App (by App id). */
export async function latestCheckRun(
  o: GitHub,
  repo: Repo,
  sha: string,
  appId: number,
): Promise<{ id: number; conclusion: string | null } | null> {
  const { data } = await o.rest.checks.listForRef({
    ...repo,
    ref: sha,
    check_name: CHECK_NAME,
    app_id: appId,
    filter: 'all',
    per_page: PAGE,
  })
  const ours = data.check_runs.filter(
    (r) => r.name === CHECK_NAME && r.app?.id === appId,
  )
  if (ours.length === 0) return null
  const latest = ours.reduce((a, b) => (b.id > a.id ? b : a))
  return { id: latest.id, conclusion: latest.conclusion }
}

/** Removes a label; a label that is not present (404) is fine. */
export async function removeLabel(
  o: GitHub,
  repo: Repo,
  pr: number,
  name: string,
): Promise<void> {
  try {
    await o.rest.issues.removeLabel({ ...repo, issue_number: pr, name })
  } catch (error) {
    if (httpStatus(error) !== 404) throw error
  }
}

/** Opens the PR; when one is already open for `head` (a re-run, GitHub answers 422) returns it. */
export async function openPullRequest(
  o: GitHub,
  repo: Repo,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<number> {
  try {
    const { data } = await o.rest.pulls.create({
      ...repo,
      head,
      base,
      title,
      body,
    })
    return data.number
  } catch (error) {
    if (httpStatus(error) !== 422) throw error
    const { data } = await o.rest.pulls.list({
      ...repo,
      head: `${repo.owner}:${head}`,
      state: 'open',
      per_page: 2,
    })
    if (data.length === 1) return data[0]!.number
    throw error
  }
}

export const RETRY_DELAYS_MS = [2000, 4000, 8000] as const

/** 5xx, 429 and errors without an HTTP status (network) are transient; other 4xx are not. */
export function isTransient(error: unknown): boolean {
  const s = httpStatus(error)
  return s === null || s >= 500 || s === 429
}

/** Runs `fn`, retrying transient failures after 2, 4 and 8 seconds. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isTransient(error)) throw error
      await sleep(delay)
    }
  }
}

const PERMISSIONS = ['admin', 'write', 'read', 'none'] as const
export type Permission = (typeof PERMISSIONS)[number]

/** Repository permission of `user` (`maintain` is reported as `write`); not a collaborator → `none`. */
export async function getPermission(
  o: GitHub,
  repo: Repo,
  user: string,
): Promise<Permission> {
  try {
    const { data } = await o.rest.repos.getCollaboratorPermissionLevel({
      ...repo,
      username: user,
    })
    return (PERMISSIONS as readonly string[]).includes(data.permission)
      ? (data.permission as Permission)
      : 'none'
  } catch (error) {
    if (httpStatus(error) === 404) return 'none'
    throw error
  }
}

/** The PR, or null when it does not exist. */
export async function getPull(
  o: GitHub,
  repo: Repo,
  pr: number,
): Promise<PullData | null> {
  try {
    return (await o.rest.pulls.get({ ...repo, pull_number: pr })).data
  } catch (error) {
    if (httpStatus(error) === 404) return null
    throw error
  }
}

export async function commitMessageOf(
  o: GitHub,
  repo: Repo,
  sha: string,
): Promise<string> {
  return (await o.rest.git.getCommit({ ...repo, commit_sha: sha })).data.message
}

/** `owner/repo` from `GITHUB_REPOSITORY`. */
export function parseRepo(full: string | undefined): Repo {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(full ?? '')
  if (!m) throw new Error('invalid GITHUB_REPOSITORY')
  return { owner: m[1]!, repo: m[2]! }
}
