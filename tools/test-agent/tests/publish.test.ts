import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMMENT_MARKER,
  outcomeFromComment,
  verdictLine,
  type RunMeta,
} from '../src/comment.ts'
import { exec as realExec, type ExecOptions } from '../src/exec.ts'
import { loadPolicy } from '../src/policy.ts'
import {
  commitMessage,
  earlyVerdict,
  fallbackVerdict,
  isPlan,
  isVerdict,
  publishRun,
  type PublishArgs,
} from '../src/publish.ts'
import type { Plan } from '../src/types.ts'
import type { Verdict } from '../src/verdict.ts'
import { emptyNumbers } from '../src/verify/numbers.ts'
import { fakeGitHub } from './github-fake.ts'
import { addedFileDiff } from './verify-harness.ts'

const repo = { owner: 'acme', repo: 'taskly' }
const BOT = 'taskly-test-agent[bot]'
const BOT_EMAIL = '99+taskly-test-agent[bot]@users.noreply.github.com'
const NEW_TEST = 'backend/tests/a.test.ts'
const EVIDENCE = 'backend/tests/__evidence__/a.test.ts'
const NEW_TEST_TEXT =
  "import { expect, it } from 'vitest'\nimport { a } from '../src/a'\n\nit('a is one', () => {\n  expect(a).toBe(1)\n})\n"
const EVIDENCE_TEXT =
  "import { expect, it } from 'vitest'\nimport { a } from '../../src/a'\n\nit('a should be two', () => {\n  expect(a).toBe(2)\n})\n"

const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Alice',
  GIT_AUTHOR_EMAIL: 'alice@example.com',
  GIT_COMMITTER_NAME: 'Alice',
  GIT_COMMITTER_EMAIL: 'alice@example.com',
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

interface Call {
  cmd: string
  args: string[]
  opts?: ExecOptions
}

interface World {
  root: string
  remote: string
  work: string
  headSha: string
  baseSha: string
  calls: Call[]
  /** Return a result to replace the real command. */
  intercept: (
    args: string[],
    cwd: string,
  ) => Promise<{ code: number; stdout: string; stderr: string } | null>
  exec: typeof realExec
  writePatch: (text: string) => Promise<string>
  remoteSha: (branch: string) => string
}

let w: World

async function makeWorld(): Promise<World> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'publish-test-')),
  )
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  const work = path.join(root, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], {
    env: GIT_ENV,
  })
  await fs.mkdir(path.join(seed, 'backend/src'), { recursive: true })
  await fs.mkdir(path.join(seed, 'backend/tests'), { recursive: true })
  await fs.writeFile(
    path.join(seed, 'backend/src/a.ts'),
    'export const a = 1\n',
  )
  await fs.writeFile(
    path.join(seed, 'backend/tests/existing.test.ts'),
    "import { expect, it } from 'vitest'\n\nit('x', () => {\n  expect(1).toBe(1)\n})\n",
  )
  sh(root, 'init', '-q', '-b', 'main', seed)
  sh(seed, 'add', '-A')
  sh(seed, 'commit', '-q', '-m', 'base')
  const baseSha = sh(seed, 'rev-parse', 'HEAD')
  sh(seed, 'checkout', '-q', '-b', 'feature')
  await fs.writeFile(
    path.join(seed, 'backend/src/a.ts'),
    'export const a = 1\nexport const b = 2\n',
  )
  sh(seed, 'commit', '-q', '-am', 'feature change')
  const headSha = sh(seed, 'rev-parse', 'HEAD')
  sh(seed, 'remote', 'add', 'origin', remote)
  sh(seed, 'push', '-q', 'origin', 'main', 'feature')
  sh(root, 'clone', '-q', '--branch', 'feature', remote, work)
  sh(work, 'checkout', '-q', '--detach', headSha)
  // Hooks must never run in publish.
  const hooks = path.join(work, '.git/hooks')
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) {
    await fs.writeFile(
      path.join(hooks, hook),
      `#!/bin/sh\ntouch "${root}/hook-ran-${hook}"\nexit 1\n`,
    )
    await fs.chmod(path.join(hooks, hook), 0o755)
  }

  const world: World = {
    root,
    remote,
    work,
    headSha,
    baseSha,
    calls: [],
    intercept: async () => null,
    exec: async (cmd, args, opts = {}) => {
      world.calls.push({ cmd, args, opts })
      const fake = await world.intercept(args, opts.cwd ?? '')
      if (fake) return { ...fake, timedOut: false }
      return realExec(cmd, args, opts)
    },
    async writePatch(text) {
      const file = path.join(root, 'patch.diff')
      await fs.writeFile(file, text)
      return file
    },
    remoteSha: (branch) => sh(remote, 'rev-parse', `refs/heads/${branch}`),
  }
  return world
}

const plan = (over: Partial<Plan> = {}): Plan => ({
  mode: 'pr',
  prNumber: 7,
  baseSha: w.baseSha,
  headSha: w.headSha,
  title: 'Add b',
  description: '',
  draft: false,
  earlyOutcome: null,
  manifest: [
    {
      path: 'backend/src/a.ts',
      app: 'backend',
      status: 'modified',
      changedLines: [2],
      excludedOnBase: false,
    },
  ],
  dependenciesChanged: false,
  testsRemovedByAuthor: [],
  budgetProfile: 'large',
  ...over,
})

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  mode: 'pr',
  outcome: 'tests-added',
  conclusion: 'success',
  commitAllowed: true,
  patchSha256: null,
  reasons: [],
  files: [{ path: 'backend/src/a.ts', action: 'create', details: NEW_TEST }],
  defects: [],
  numbers: { backend: emptyNumbers(), frontend: emptyNumbers() },
  banners: {
    dependenciesChanged: false,
    testsRemovedByAuthor: [],
    configChanged: false,
  },
  baselineFailures: [],
  ...over,
})

const meta: RunMeta = {
  runUrl: 'https://github.com/acme/taskly/actions/runs/123',
  model: 'claude-sonnet',
  budgetProfile: 'large',
  skills: null,
  turns: null,
  costUsd: null,
}

async function args(
  patchText: string,
  over: Partial<PublishArgs> = {},
): Promise<PublishArgs> {
  const patchPath = await w.writePatch(patchText)
  return {
    verdict: verdict({ patchSha256: sha256(patchText) }),
    patchPath,
    generateSha256: `${sha256(patchText)}  patch.diff\n`,
    workDir: w.work,
    plan: plan(),
    runId: '123',
    botName: BOT,
    botEmail: BOT_EMAIL,
    botLogin: BOT,
    headRef: 'feature',
    baseRef: null,
    report: null,
    meta,
    ...over,
  }
}

const pushes = () => w.calls.filter((c) => c.args.includes('push'))
const checks = (state: ReturnType<typeof fakeGitHub>['state']) =>
  state.calls.filter((c) => c.method === 'checks.create')

beforeEach(async () => {
  w = await makeWorld()
})

afterEach(async () => {
  await fs.rm(w.root, { recursive: true, force: true })
})

describe('commitMessage', () => {
  it('formats PR and backfill messages with the trailer', () => {
    expect(commitMessage(7, null, '123')).toBe(
      'test(agent): add unit tests for #7\n\nTest-Agent-Run: 123',
    )
    expect(commitMessage(null, 'frontend', '9')).toBe(
      'test(agent): backfill frontend unit tests\n\nTest-Agent-Run: 9',
    )
  })

  it('rejects an invalid run id', () => {
    expect(() => commitMessage(7, null, '1\n\nSigned-off-by: x')).toThrow()
  })
})

describe('publishRun (pr mode)', () => {
  it('commits, pushes with CAS and reports on the new SHA', async () => {
    const { gh, state } = fakeGitHub()
    state.labels.set(7, ['test-agent:retry-large'])
    const patch = addedFileDiff(NEW_TEST, NEW_TEST_TEXT)
    const r = await publishRun(await args(patch), {
      exec: w.exec,
      octokit: gh,
      repo,
    })
    const newSha = w.remoteSha('feature')
    expect(r).toMatchObject({ outcome: 'tests-added', checkSha: newSha })
    expect(newSha).not.toBe(w.headSha)
    expect(sh(w.remote, 'rev-parse', `${newSha}^`)).toBe(w.headSha)
    const msg = sh(w.remote, 'log', '-1', '--format=%B', newSha)
    expect(msg).toBe(
      'test(agent): add unit tests for #7\n\nTest-Agent-Run: 123',
    )
    expect(msg.endsWith('Test-Agent-Run: 123')).toBe(true)
    expect(
      sh(w.remote, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', newSha),
    ).toBe(`${BOT} <${BOT_EMAIL}>|${BOT} <${BOT_EMAIL}>`)
    expect(
      sh(
        w.remote,
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '-r',
        newSha,
      ),
    ).toBe(`A\t${NEW_TEST}`)
    expect(sh(w.remote, 'show', `${newSha}:${NEW_TEST}`)).toBe(
      NEW_TEST_TEXT.trimEnd(),
    )

    const push = pushes()[0]!
    expect(push.args).toContain('HEAD:refs/heads/feature')
    expect(push.args).toContain(
      `--force-with-lease=refs/heads/feature:${w.headSha}`,
    )
    expect(checks(state)).toHaveLength(1)
    expect(checks(state)[0]!.params).toMatchObject({
      name: 'test-agent/verified',
      head_sha: newSha,
      conclusion: 'success',
      details_url: meta.runUrl,
      output: { title: verdictLine('tests-added') },
    })
    expect(state.comments).toHaveLength(1)
    expect(state.comments[0]!.body.startsWith(COMMENT_MARKER)).toBe(true)
    expect(outcomeFromComment(state.comments[0]!.body)).toBe('tests-added')
    expect(state.labels.get(7)).toEqual([])
    // Publish only ever runs git, and never a hook.
    expect(w.calls.every((c) => c.cmd === 'git')).toBe(true)
    const ran = (await fs.readdir(w.root)).filter((f) =>
      f.startsWith('hook-ran'),
    )
    expect(ran).toEqual([])
  })

  it('Review Focus 5: a rejected CAS push (stale info) yields head-moved, no check run, and says so', async () => {
    const { gh, state } = fakeGitHub()
    w.intercept = async (a) =>
      a.includes('push')
        ? {
            code: 1,
            stdout: '',
            stderr:
              'To github.com:acme/taskly.git\n ! [rejected]        HEAD -> feature (stale info)\nerror: failed to push some refs\n',
          }
        : null
    const r = await publishRun(
      await args(addedFileDiff(NEW_TEST, NEW_TEST_TEXT)),
      { exec: w.exec, octokit: gh, repo },
    )
    expect(r).toMatchObject({ outcome: 'head-moved', checkSha: null })
    expect(checks(state)).toHaveLength(0)
    const body = state.comments[0]!.body
    expect(body).toContain(verdictLine('head-moved'))
    expect(body).toMatch(/new run/)
    expect(outcomeFromComment(body)).toBe('head-moved')
    expect(w.remoteSha('feature')).toBe(w.headSha)
  })

  it('Review Focus 5 with real git: the branch moved after plan, so the CAS push is rejected', async () => {
    const other = path.join(w.root, 'other')
    sh(w.root, 'clone', '-q', '--branch', 'feature', w.remote, other)
    await fs.writeFile(path.join(other, 'backend/src/a.ts'), 'moved\n')
    sh(other, 'commit', '-q', '-am', 'author pushes again')
    sh(other, 'push', '-q', 'origin', 'feature')
    const moved = w.remoteSha('feature')

    const { gh, state } = fakeGitHub()
    const r = await publishRun(
      await args(addedFileDiff(NEW_TEST, NEW_TEST_TEXT)),
      { exec: w.exec, octokit: gh, repo },
    )
    expect(r.outcome).toBe('head-moved')
    expect(w.remoteSha('feature')).toBe(moved)
    expect(checks(state)).toHaveLength(0)
    expect(state.comments[0]!.body).toContain(verdictLine('head-moved'))
  })

  it('rejects a patch whose hash differs from generate without pushing', async () => {
    const { gh, state } = fakeGitHub()
    const patch = addedFileDiff(NEW_TEST, NEW_TEST_TEXT)
    const r = await publishRun(
      await args(patch, { generateSha256: 'f'.repeat(64) }),
      { exec: w.exec, octokit: gh, repo },
    )
    expect(r).toMatchObject({ outcome: 'patch-rejected', checkSha: w.headSha })
    expect(pushes()).toHaveLength(0)
    expect(w.calls.some((c) => c.args.includes('commit'))).toBe(false)
    expect(checks(state)[0]!.params).toMatchObject({
      head_sha: w.headSha,
      conclusion: 'neutral',
    })
    expect(outcomeFromComment(state.comments[0]!.body)).toBe('patch-rejected')
  })

  it('rejects a patch whose hash differs from the verified one', async () => {
    const { gh } = fakeGitHub()
    const patch = addedFileDiff(NEW_TEST, NEW_TEST_TEXT)
    const a = await args(patch)
    a.verdict = verdict({ patchSha256: 'e'.repeat(64) })
    const r = await publishRun(a, { exec: w.exec, octokit: gh, repo })
    expect(r.outcome).toBe('patch-rejected')
    expect(pushes()).toHaveLength(0)
  })

  it('rejects a missing patch', async () => {
    const { gh } = fakeGitHub()
    const a = await args('x')
    a.patchPath = path.join(w.root, 'missing.diff')
    const r = await publishRun(a, { exec: w.exec, octokit: gh, repo })
    expect(r.outcome).toBe('patch-rejected')
    expect(w.calls).toHaveLength(0)
  })

  it('re-runs the gates on the patch as data: a source change is rejected', async () => {
    const { gh } = fakeGitHub()
    const patch =
      'diff --git a/backend/src/a.ts b/backend/src/a.ts\n--- a/backend/src/a.ts\n+++ b/backend/src/a.ts\n@@ -1,2 +1,2 @@\n-export const a = 1\n+export const a = 2\n export const b = 2\n'
    const r = await publishRun(await args(patch), {
      exec: w.exec,
      octokit: gh,
      repo,
    })
    expect(r.outcome).toBe('patch-rejected')
    expect(pushes()).toHaveLength(0)
    expect(w.calls.some((c) => c.args.includes('apply'))).toBe(false)
  })

  it('R6: refuses to commit when git apply changed a path outside the test globs', async () => {
    const { gh, state } = fakeGitHub()
    w.intercept = async (a, cwd) => {
      if (!a.includes('apply')) return null
      const r = await realExec('git', a, { cwd, env: GIT_ENV })
      await fs.writeFile(path.join(cwd, 'backend/src/a.ts'), 'evil\n')
      return r
    }
    const r = await publishRun(
      await args(addedFileDiff(NEW_TEST, NEW_TEST_TEXT)),
      { exec: w.exec, octokit: gh, repo },
    )
    expect(r.outcome).toBe('patch-rejected')
    expect(w.calls.some((c) => c.args.includes('commit'))).toBe(false)
    expect(pushes()).toHaveLength(0)
    expect(state.comments[0]!.body).toContain('backend/src/a.ts')
  })

  it('R6: refuses a deletion that git apply performed', async () => {
    const { gh } = fakeGitHub()
    w.intercept = async (a, cwd) => {
      if (!a.includes('apply')) return null
      const r = await realExec('git', a, { cwd, env: GIT_ENV })
      await fs.rm(path.join(cwd, 'backend/tests/existing.test.ts'))
      return r
    }
    const r = await publishRun(
      await args(addedFileDiff(NEW_TEST, NEW_TEST_TEXT)),
      { exec: w.exec, octokit: gh, repo },
    )
    expect(r.outcome).toBe('patch-rejected')
    expect(pushes()).toHaveLength(0)
  })

  it('commits without evidence files and keeps a defect failure on the new SHA', async () => {
    const { gh, state } = fakeGitHub()
    const patch =
      addedFileDiff(NEW_TEST, NEW_TEST_TEXT) +
      addedFileDiff(EVIDENCE, EVIDENCE_TEXT)
    const a = await args(patch)
    a.verdict = verdict({
      patchSha256: sha256(patch),
      outcome: 'defect',
      conclusion: 'failure',
      defects: [
        {
          file: 'backend/src/a.ts',
          evidenceTest: EVIDENCE,
          citation: 'PR description: "a must be two"',
          accepted: true,
        },
      ],
    })
    const r = await publishRun(a, { exec: w.exec, octokit: gh, repo })
    const newSha = w.remoteSha('feature')
    expect(r).toMatchObject({ outcome: 'defect', checkSha: newSha })
    expect(
      sh(w.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', newSha),
    ).toBe(NEW_TEST)
    expect(checks(state)[0]!.params).toMatchObject({ conclusion: 'failure' })
    const body = state.comments[0]!.body
    expect(outcomeFromComment(body)).toBe('defect')
    // The evidence source (from the hash-checked patch) is shown in the comment.
    expect(body).toContain("it('a should be two'")
  })

  it('does not touch git when no commit is allowed', async () => {
    const { gh, state } = fakeGitHub()
    const patch = addedFileDiff(NEW_TEST, NEW_TEST_TEXT)
    const a = await args(patch)
    a.verdict = verdict({
      patchSha256: sha256(patch),
      outcome: 'verification-failed',
      conclusion: 'neutral',
      commitAllowed: false,
    })
    const r = await publishRun(a, { exec: w.exec, octokit: gh, repo })
    expect(r).toMatchObject({
      outcome: 'verification-failed',
      checkSha: w.headSha,
    })
    expect(w.calls).toHaveLength(0)
    expect(checks(state)[0]!.params).toMatchObject({
      head_sha: w.headSha,
      conclusion: 'neutral',
    })
  })

  it('recomputes the conclusion from the outcome', async () => {
    const { gh, state } = fakeGitHub()
    const a = await args('')
    a.verdict = verdict({
      outcome: 'verification-failed',
      conclusion: 'success',
      commitAllowed: false,
    })
    await publishRun(a, { exec: w.exec, octokit: gh, repo })
    expect(checks(state)[0]!.params).toMatchObject({ conclusion: 'neutral' })
  })

  it('reports pipeline-error when the work dir is not at the analysed head', async () => {
    const { gh, state } = fakeGitHub()
    sh(w.work, 'checkout', '-q', '--detach', w.baseSha)
    const r = await publishRun(
      await args(addedFileDiff(NEW_TEST, NEW_TEST_TEXT)),
      { exec: w.exec, octokit: gh, repo },
    )
    expect(r).toMatchObject({ outcome: 'pipeline-error', checkSha: w.headSha })
    expect(pushes()).toHaveLength(0)
    expect(checks(state)[0]!.params).toMatchObject({ conclusion: 'neutral' })
  })

  it('reports pipeline-error when the push fails for another reason', async () => {
    const { gh } = fakeGitHub()
    w.intercept = async (a) =>
      a.includes('push')
        ? { code: 128, stdout: '', stderr: 'fatal: Authentication failed\n' }
        : null
    const r = await publishRun(
      await args(addedFileDiff(NEW_TEST, NEW_TEST_TEXT)),
      { exec: w.exec, octokit: gh, repo },
    )
    expect(r.outcome).toBe('pipeline-error')
  })

  it('rejects an invalid head ref before running git', async () => {
    const { gh } = fakeGitHub()
    await expect(
      publishRun(
        await args(addedFileDiff(NEW_TEST, NEW_TEST_TEXT), {
          headRef: 'feature:refs/heads/main',
        }),
        { exec: w.exec, octokit: gh, repo },
      ),
    ).rejects.toThrow(/head ref/)
    expect(w.calls).toHaveLength(0)
  })
})

describe('publishRun (backfill mode)', () => {
  it('pushes a new branch from base, opens the PR and reports on it', async () => {
    const { gh, state } = fakeGitHub()
    sh(w.work, 'checkout', '-q', '--detach', w.baseSha)
    const patch = addedFileDiff(NEW_TEST, NEW_TEST_TEXT)
    const a = await args(patch, {
      plan: plan({
        mode: 'backfill',
        prNumber: null,
        headSha: w.baseSha,
        budgetProfile: 'backfill',
      }),
      headRef: null,
      baseRef: 'main',
    })
    a.verdict = verdict({ mode: 'backfill', patchSha256: sha256(patch) })
    const r = await publishRun(a, { exec: w.exec, octokit: gh, repo })
    const branch = 'test-agent/backfill-backend-123'
    const newSha = w.remoteSha(branch)
    expect(r).toMatchObject({
      outcome: 'tests-added',
      checkSha: newSha,
      prNumber: 100,
    })
    expect(sh(w.remote, 'rev-parse', `${newSha}^`)).toBe(w.baseSha)
    expect(sh(w.remote, 'log', '-1', '--format=%B', newSha)).toBe(
      'test(agent): backfill backend unit tests\n\nTest-Agent-Run: 123',
    )
    expect(pushes()[0]!.args).toContain(
      `--force-with-lease=refs/heads/${branch}:`,
    )
    expect(state.created[0]).toMatchObject({ head: branch, base: 'main' })
    expect(checks(state)[0]!.params).toMatchObject({ head_sha: newSha })
    expect(
      state.calls.find((c) => c.method === 'issues.createComment')?.params,
    ).toMatchObject({ issue_number: 100 })
  })

  it('opens no PR when nothing may be committed', async () => {
    const { gh, state } = fakeGitHub()
    const a = await args('', {
      plan: plan({ mode: 'backfill', prNumber: null, headSha: w.baseSha }),
      headRef: null,
      baseRef: 'main',
    })
    a.verdict = verdict({
      mode: 'backfill',
      outcome: 'verification-failed',
      conclusion: 'neutral',
      commitAllowed: false,
    })
    const r = await publishRun(a, { exec: w.exec, octokit: gh, repo })
    expect(r).toMatchObject({
      outcome: 'verification-failed',
      checkSha: null,
      prNumber: null,
    })
    expect(r.comment).toContain(verdictLine('verification-failed'))
    expect(state.calls).toEqual([])
  })

  it('does not reuse an existing backfill branch', async () => {
    const { gh, state } = fakeGitHub()
    sh(w.work, 'checkout', '-q', '--detach', w.baseSha)
    sh(
      w.remote,
      'update-ref',
      'refs/heads/test-agent/backfill-backend-123',
      w.baseSha,
    )
    const patch = addedFileDiff(NEW_TEST, NEW_TEST_TEXT)
    const a = await args(patch, {
      plan: plan({ mode: 'backfill', prNumber: null, headSha: w.baseSha }),
      headRef: null,
      baseRef: 'main',
    })
    a.verdict = verdict({ mode: 'backfill', patchSha256: sha256(patch) })
    const r = await publishRun(a, { exec: w.exec, octokit: gh, repo })
    expect(r.outcome).toBe('pipeline-error')
    expect(state.created).toEqual([])
    expect(w.remoteSha('test-agent/backfill-backend-123')).toBe(w.baseSha)
  })
})

describe('early outcomes and artifact validation', () => {
  it('posts a draft early outcome on the analysed head without git', async () => {
    const { gh, state } = fakeGitHub()
    const p = plan({ earlyOutcome: 'draft', draft: true })
    const a = await args('', { plan: p })
    a.verdict = earlyVerdict(p, loadPolicy())
    const r = await publishRun(a, { exec: w.exec, octokit: gh, repo })
    expect(r).toMatchObject({ outcome: 'draft', checkSha: w.headSha })
    expect(w.calls).toHaveLength(0)
    expect(checks(state)[0]!.params).toMatchObject({
      conclusion: 'neutral',
      output: { title: verdictLine('draft') },
    })
  })

  it('reports pipeline-error from a fallback verdict', async () => {
    const { gh, state } = fakeGitHub()
    const a = await args('')
    a.verdict = fallbackVerdict(plan(), 'pipeline-error', ['verify crashed'])
    const r = await publishRun(a, { exec: w.exec, octokit: gh, repo })
    expect(r.outcome).toBe('pipeline-error')
    expect(state.comments[0]!.body).toContain('verify crashed')
  })

  it('rejects a verdict whose mode differs from the plan', async () => {
    const { gh } = fakeGitHub()
    const a = await args('')
    a.verdict = verdict({ mode: 'backfill', commitAllowed: false })
    expect(
      (await publishRun(a, { exec: w.exec, octokit: gh, repo })).outcome,
    ).toBe('pipeline-error')
  })

  it('validates verdict and plan shapes', () => {
    expect(isVerdict(verdict())).toBe(true)
    expect(isVerdict(JSON.parse(JSON.stringify(verdict())))).toBe(true)
    expect(isVerdict({ ...verdict(), reasons: [1] })).toBe(false)
    expect(isVerdict(null)).toBe(false)
    expect(isPlan(plan())).toBe(true)
    expect(isPlan({ ...plan(), headSha: 'x' })).toBe(false)
    expect(isPlan({ ...plan(), prNumber: null })).toBe(false)
    expect(isPlan({ ...plan(), earlyOutcome: 'defect' })).toBe(false)
  })
})
