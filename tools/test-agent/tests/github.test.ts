import { describe, expect, it } from 'vitest'
import { COMMENT_MARKER } from '../src/comment.ts'
import {
  CHECK_NAME,
  createCheckRun,
  findOwnComment,
  getPermission,
  latestCheckRun,
  openPullRequest,
  removeLabel,
  upsertComment,
  withRetry,
} from '../src/github.ts'
import { fakeGitHub, HttpError } from './github-fake.ts'

const repo = { owner: 'acme', repo: 'taskly' }
const BOT = 'taskly-test-agent[bot]'
const SHA = 'c'.repeat(40)

describe('upsertComment', () => {
  it('creates a comment when none exists', async () => {
    const { gh, state } = fakeGitHub()
    await upsertComment(gh, repo, 7, `${COMMENT_MARKER}\nhello`, BOT)
    expect(state.comments).toHaveLength(1)
    expect(
      state.calls.find((c) => c.method === 'issues.createComment')?.params,
    ).toMatchObject({ issue_number: 7, body: `${COMMENT_MARKER}\nhello` })
  })

  it('updates the existing bot comment and ignores a human comment with the marker', async () => {
    const { gh, state } = fakeGitHub()
    state.comments.push(
      { id: 1, body: `${COMMENT_MARKER}\nforged`, user: { login: 'mallory' } },
      { id: 2, body: 'unrelated', user: { login: BOT } },
      { id: 3, body: `${COMMENT_MARKER}\nold`, user: { login: BOT } },
    )
    await upsertComment(gh, repo, 7, `${COMMENT_MARKER}\nnew`, BOT)
    expect(state.comments.map((c) => c.body)).toEqual([
      `${COMMENT_MARKER}\nforged`,
      'unrelated',
      `${COMMENT_MARKER}\nnew`,
    ])
    expect(
      state.calls.filter((c) => c.method === 'issues.createComment'),
    ).toHaveLength(0)
  })

  it('does not adopt a bot comment that merely contains the marker later on', async () => {
    const { gh, state } = fakeGitHub()
    state.comments.push({
      id: 1,
      body: `quoted:\n${COMMENT_MARKER}`,
      user: { login: BOT },
    })
    expect(await findOwnComment(gh, repo, 7, BOT)).toBeNull()
  })

  it('pages through comments', async () => {
    const { gh, state } = fakeGitHub()
    for (let i = 0; i < 150; i++)
      state.comments.push({ id: i + 1, body: `c${i}`, user: { login: 'x' } })
    state.comments.push({
      id: 999,
      body: `${COMMENT_MARKER}\nmine`,
      user: { login: BOT },
    })
    expect(await findOwnComment(gh, repo, 7, BOT)).toEqual({
      id: 999,
      body: `${COMMENT_MARKER}\nmine`,
    })
  })
})

describe('createCheckRun', () => {
  it('creates a completed test-agent/verified check run', async () => {
    const { gh, state } = fakeGitHub()
    await createCheckRun(
      gh,
      repo,
      SHA,
      'neutral',
      'Title',
      'Summary',
      'https://github.com/acme/taskly/actions/runs/1',
    )
    expect(state.calls[0]).toMatchObject({
      method: 'checks.create',
      params: {
        owner: 'acme',
        repo: 'taskly',
        name: 'test-agent/verified',
        head_sha: SHA,
        status: 'completed',
        conclusion: 'neutral',
        details_url: 'https://github.com/acme/taskly/actions/runs/1',
        output: { title: 'Title', summary: 'Summary' },
      },
    })
    expect(CHECK_NAME).toBe('test-agent/verified')
  })
})

describe('latestCheckRun', () => {
  it("returns our App's newest check run on the SHA", async () => {
    const { gh, state } = fakeGitHub(42)
    const run = (id: number, conclusion: string, appId: number) => ({
      id,
      name: CHECK_NAME,
      head_sha: SHA,
      status: 'completed',
      conclusion,
      app: { id: appId },
      output: { title: '', summary: '' },
      details_url: '',
    })
    state.checkRuns.push(
      run(5, 'failure', 42),
      run(9, 'success', 7),
      run(6, 'neutral', 42),
    )
    expect(await latestCheckRun(gh, repo, SHA, 42)).toEqual({
      id: 6,
      conclusion: 'neutral',
    })
    expect(await latestCheckRun(gh, repo, 'd'.repeat(40), 42)).toBeNull()
  })
})

describe('removeLabel', () => {
  it('removes a label and ignores a missing one', async () => {
    const { gh, state } = fakeGitHub()
    state.labels.set(7, ['test-agent:retry-large'])
    await removeLabel(gh, repo, 7, 'test-agent:retry-large')
    expect(state.labels.get(7)).toEqual([])
    await expect(
      removeLabel(gh, repo, 7, 'test-agent:retry-large'),
    ).resolves.toBeUndefined()
  })

  it('rethrows other errors', async () => {
    const { gh } = fakeGitHub()
    gh.rest.issues.removeLabel = async () => {
      throw new HttpError(500)
    }
    await expect(removeLabel(gh, repo, 7, 'x')).rejects.toThrow('HTTP 500')
  })
})

describe('openPullRequest', () => {
  it('returns the new PR number', async () => {
    const { gh, state } = fakeGitHub()
    expect(await openPullRequest(gh, repo, 'b', 'main', 'T', 'B')).toBe(100)
    expect(state.created[0]).toMatchObject({ head: 'b', base: 'main' })
  })
})

describe('getPermission', () => {
  it('maps the permission and treats non-collaborators as none', async () => {
    const { gh, state } = fakeGitHub()
    state.permissions.set('bob', 'write')
    state.permissions.set('eve', 'weird')
    expect(await getPermission(gh, repo, 'bob')).toBe('write')
    expect(await getPermission(gh, repo, 'eve')).toBe('none')
    expect(await getPermission(gh, repo, 'nobody')).toBe('none')
  })
})

describe('withRetry', () => {
  it('retries transient errors up to three times, then rethrows', async () => {
    const sleeps: number[] = []
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new HttpError(500)
        },
        async (ms) => {
          sleeps.push(ms)
        },
      ),
    ).rejects.toThrow('HTTP 500')
    expect(calls).toBe(4)
    expect(sleeps).toEqual([2000, 4000, 8000])
  })

  it('does not retry a 404', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new HttpError(404)
        },
        async () => {},
      ),
    ).rejects.toThrow('HTTP 404')
    expect(calls).toBe(1)
  })
})

describe('openPullRequest on a re-run', () => {
  it('returns the PR already open for the branch', async () => {
    const { gh } = fakeGitHub()
    expect(await openPullRequest(gh, repo, 'b', 'main', 'T', 'B')).toBe(100)
    expect(await openPullRequest(gh, repo, 'b', 'main', 'T', 'B')).toBe(100)
  })

  it('rethrows a 422 when no open PR exists for the branch', async () => {
    const { gh } = fakeGitHub()
    gh.rest.pulls.create = async () => {
      throw new HttpError(422)
    }
    await expect(
      openPullRequest(gh, repo, 'b', 'main', 'T', 'B'),
    ).rejects.toThrow('HTTP 422')
  })
})
