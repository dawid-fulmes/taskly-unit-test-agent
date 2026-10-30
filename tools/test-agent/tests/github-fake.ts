import type { GitHub } from '../src/github.ts'

export interface FakeComment {
  id: number
  body: string
  user: { login: string } | null
}

export interface FakeCheckRun {
  id: number
  name: string
  head_sha: string
  status: string
  conclusion: string | null
  app: { id: number } | null
  output: { title: string; summary: string }
  details_url: string
}

export interface FakePull {
  number: number
  draft: boolean
  head: { sha: string; ref: string; repo: { full_name: string } | null }
  base: { ref: string; repo: { full_name: string } }
  labels: { name: string }[]
  user: { login: string } | null
}

export class HttpError extends Error {
  status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

/** In-memory GitHub with only what the tooling uses; `calls` records every request. */
export function fakeGitHub(appId = 42) {
  const state = {
    comments: [] as FakeComment[],
    checkRuns: [] as FakeCheckRun[],
    labels: new Map<number, string[]>(),
    pulls: new Map<number, FakePull>(),
    created: [] as {
      head: string
      base: string
      title: string
      body: string
      number: number
    }[],
    permissions: new Map<string, string>(),
    commits: new Map<string, string>(),
    calls: [] as { method: string; params: Record<string, unknown> }[],
    nextId: 1000,
  }
  const rec = (method: string, params: object) =>
    state.calls.push({ method, params: { ...params } })

  const gh: GitHub = {
    rest: {
      issues: {
        async listComments(p) {
          rec('issues.listComments', p)
          const per = p.per_page ?? 30
          const page = p.page ?? 1
          return {
            data: state.comments
              .slice((page - 1) * per, page * per)
              .map((c) => ({ ...c })),
          }
        },
        async createComment(p) {
          rec('issues.createComment', p)
          state.comments.push({
            id: state.nextId++,
            body: p.body,
            user: { login: 'taskly-test-agent[bot]' },
          })
          return {}
        },
        async updateComment(p) {
          rec('issues.updateComment', p)
          const c = state.comments.find((x) => x.id === p.comment_id)
          if (!c) throw new HttpError(404)
          c.body = p.body
          return {}
        },
        async removeLabel(p) {
          rec('issues.removeLabel', p)
          const labels = state.labels.get(p.issue_number) ?? []
          if (!labels.includes(p.name)) throw new HttpError(404)
          state.labels.set(
            p.issue_number,
            labels.filter((l) => l !== p.name),
          )
          return {}
        },
      },
      checks: {
        async create(p) {
          rec('checks.create', p)
          const run: FakeCheckRun = {
            id: state.nextId++,
            name: p.name,
            head_sha: p.head_sha,
            status: p.status,
            conclusion: p.conclusion,
            app: { id: appId },
            output: p.output,
            details_url: p.details_url,
          }
          state.checkRuns.push(run)
          return { data: { id: run.id } }
        },
        async listForRef(p) {
          rec('checks.listForRef', p)
          return {
            data: {
              check_runs: state.checkRuns.filter(
                (r) =>
                  r.head_sha === p.ref &&
                  r.name === p.check_name &&
                  (p.app_id === undefined || r.app?.id === p.app_id),
              ),
            },
          }
        },
      },
      pulls: {
        async create(p) {
          rec('pulls.create', p)
          const number = state.created.length + 100
          state.created.push({ ...p, number })
          return { data: { number } }
        },
        async get(p) {
          rec('pulls.get', p)
          const pr = state.pulls.get(p.pull_number)
          if (!pr) throw new HttpError(404)
          return { data: pr }
        },
      },
      repos: {
        async getCollaboratorPermissionLevel(p) {
          rec('repos.getCollaboratorPermissionLevel', p)
          const perm = state.permissions.get(p.username)
          if (perm === undefined) throw new HttpError(404)
          return { data: { permission: perm } }
        },
      },
      git: {
        async getCommit(p) {
          rec('git.getCommit', p)
          const message = state.commits.get(p.commit_sha)
          if (message === undefined) throw new HttpError(404)
          return { data: { message } }
        },
      },
    },
  }
  return { gh, state }
}
