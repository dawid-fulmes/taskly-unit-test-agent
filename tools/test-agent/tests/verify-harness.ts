import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseUnifiedDiff } from '../src/diff.ts'
import type { ExecOptions, ExecResult } from '../src/exec.ts'
import type { Report } from '../src/report.ts'
import type { Plan } from '../src/types.ts'
import type { VerifyArgs, VerifyDeps } from '../src/verify.ts'

/** Repo root: holds the trusted policy at tools/test-agent/policy.json. */
export const TRUSTED = path.resolve(import.meta.dirname, '../../..')
export const HEAD = 'head-sha'
export const NEW_TEST = 'backend/tests/a.test.ts'
export const EXISTING_TEST = 'backend/tests/existing.test.ts'
export const EVIDENCE = 'backend/tests/__evidence__/a.test.ts'

export interface Call {
  cmd: string
  args: string[]
  opts?: ExecOptions
}

export interface DockerRun {
  step: string
  argv: string[]
  appDir: string
  resultsDir: string
  command: string[]
  /** Test files present in the mounted app dir (repo-relative) when the container ran. */
  testFiles: string[]
}

type Json = Record<string, unknown>
export interface DockerResult {
  code: number
  json?: Json | null
  coverage?: Json | null
}
export type DockerHandler = (
  run: DockerRun,
  defaults: () => Promise<DockerResult>,
) => Promise<DockerResult>

export const WORK_FILES: Record<string, string> = {
  'backend/package.json': '{}\n',
  'backend/openapi.json': JSON.stringify({
    paths: { '/todos': { post: { responses: { '422': {} } } } },
  }),
  'backend/src/a.ts': 'export const a = 1\nexport const a2 = 2\n',
  'backend/src/b.ts': 'export const b = 1\n',
  [EXISTING_TEST]:
    "import { expect, it } from 'vitest'\nimport { b } from '../src/b'\n\nit('existing works', () => {\n  expect(b).toBe(1)\n})\n",
  'backend/node_modules/dep/index.js': 'module.exports = 1\n',
  'frontend/package.json': '{}\n',
  'frontend/src/x.tsx': 'export const x = 1\n',
  'frontend/src/x.test.tsx':
    "import { expect, it } from 'vitest'\nimport { x } from './x'\n\nit('x works', () => {\n  expect(x).toBe(1)\n})\n",
}

export const NEW_TEST_TEXT =
  "import { expect, it } from 'vitest'\nimport { a, a2 } from '../src/a'\n\nit('a is one', () => {\n  expect(a).toBe(1)\n  expect(a2).toBe(2)\n})\n"

export const EVIDENCE_TEXT =
  "import { expect, it } from 'vitest'\nimport { a } from '../../src/a'\n\nit('a should be two', () => {\n  expect(a).toBe(2)\n})\n"

export function addedFileDiff(file: string, text: string): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`
}

export const plan = (): Plan => ({
  mode: 'pr',
  prNumber: 7,
  baseSha: 'base-sha',
  headSha: HEAD,
  title: 'Add a',
  description: 'Creating a todo with an empty title must return 422.',
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
      changedLines: [1],
      excludedOnBase: false,
    },
  ],
  dependenciesChanged: false,
  testsRemovedByAuthor: [],
  budgetProfile: 'default',
})

export const report = (): Report => ({
  files: [
    { path: 'backend/src/a.ts', action: 'create', testFile: NEW_TEST },
    {
      path: 'backend/src/b.ts',
      action: 'skip',
      skip: { file: EXISTING_TEST, testName: 'existing works' },
    },
  ],
  behaviours: [],
  defects: [],
  narrative: 'Added tests for a.',
})

const vitestFile = (
  name: string,
  tests: { name: string; status: string; message?: string }[],
) => ({
  name,
  status: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
  message: '',
  assertionResults: tests.map((t) => ({
    fullName: t.name,
    title: t.name,
    status: t.status,
    failureMessages: t.message ? [t.message] : [],
  })),
})

export function vitestJson(
  files: {
    file: string
    tests: { name: string; status: string; message?: string }[]
  }[],
): Json {
  const all = files.flatMap((f) => f.tests)
  const failed = all.filter((t) => t.status === 'failed').length
  return {
    numTotalTests: all.length,
    numFailedTests: failed,
    success: failed === 0,
    testResults: files.map((f) => vitestFile(`/app/${f.file}`, f.tests)),
  }
}

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const child = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...(await walk(dir, child)))
    } else out.push(child)
  }
  return out
}

const TEST_NAME = /\bit\('([^']+)'/g

/**
 * Default container behaviour: tsc/prisma succeed; vitest "runs" the given files (or every
 * test file) and passes every `it('…')`. A source file counts as covered when an executed test
 * imports it.
 */
async function defaultDocker(run: DockerRun): Promise<DockerResult> {
  const [, tool, ...rest] = run.command
  if (tool !== 'vitest') return { code: 0 }
  const explicit = rest.filter((a) => a !== 'run' && !a.startsWith('--'))
  const files =
    explicit.length > 0
      ? explicit
      : (await walk(run.appDir)).filter((f) => /\.test\.tsx?$/.test(f))
  const results = []
  const texts: string[] = []
  for (const f of files) {
    const text = await fs.readFile(path.join(run.appDir, f), 'utf8')
    texts.push(text)
    results.push({
      file: f,
      tests: [...text.matchAll(TEST_NAME)].map((m) => ({
        name: m[1]!,
        status: 'passed',
      })),
    })
  }
  const coverage: Json = {}
  if (run.command.includes('--coverage.enabled=true'))
    for (const src of await walk(run.appDir, 'src')) {
      if (/\.test\.tsx?$/.test(src)) continue
      const lines = (await fs.readFile(path.join(run.appDir, src), 'utf8'))
        .split('\n')
        .filter((l) => l !== '')
      const base = src.replace(/^src\//, '').replace(/\.tsx?$/, '')
      const hit = texts.some(
        (t) => t.includes(`src/${base}'`) || t.includes(`./${base}'`),
      )
      coverage[`/app/${src}`] = {
        path: `/app/${src}`,
        statementMap: Object.fromEntries(
          lines.map((_, i) => [
            String(i),
            { start: { line: i + 1 }, end: { line: i + 1 } },
          ]),
        ),
        s: Object.fromEntries(lines.map((_, i) => [String(i), hit ? 1 : 0])),
      }
    }
  return { code: 0, json: vitestJson(results), coverage }
}

export interface World {
  workDir: string
  runDir: string
  calls: Call[]
  docker: DockerRun[]
  args: VerifyArgs
  deps: VerifyDeps
  /** Per-step override of container behaviour. */
  onDocker: DockerHandler
  /** Runs after the fake `git apply` wrote the patch into a dir. */
  onApply: (cwd: string) => Promise<void>
  head: string
  writePatch: (text: string, sha?: string) => Promise<void>
  writeReport: (r: unknown) => Promise<void>
  inputs: () => Promise<Json>
  cleanup: () => Promise<void>
}

export async function makeWorld(): Promise<World> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'verify-test-'))
  const workDir = path.join(root, 'work')
  const runDir = path.join(root, 'run')
  const inDir = path.join(root, 'in')
  await fs.mkdir(inDir, { recursive: true })
  for (const [file, text] of Object.entries(WORK_FILES)) {
    await fs.mkdir(path.dirname(path.join(workDir, file)), { recursive: true })
    await fs.writeFile(path.join(workDir, file), text)
  }
  const initial = new Map<string, string>()
  for (const f of await walk(workDir))
    initial.set(f, await fs.readFile(path.join(workDir, f), 'utf8'))

  const ok = (stdout = ''): ExecResult => ({
    code: 0,
    stdout,
    stderr: '',
    timedOut: false,
  })

  const world: World = {
    workDir,
    runDir,
    calls: [],
    docker: [],
    head: HEAD,
    onDocker: (_run, defaults) => defaults(),
    onApply: async () => {},
    args: {
      trustedDir: TRUSTED,
      workDir,
      runDir,
      plan: plan(),
      patchPath: path.join(inDir, 'patch.diff'),
      patchShaPath: path.join(inDir, 'patch.sha256'),
      reportPath: path.join(inDir, 'report.json'),
      transcriptPath: path.join(inDir, 'transcript.jsonl'),
      guardLogPath: path.join(inDir, 'guard.jsonl'),
      agentStop: 'success',
    },
    deps: undefined as unknown as VerifyDeps,
    async writePatch(text, sha) {
      await fs.writeFile(world.args.patchPath, text)
      await fs.writeFile(
        world.args.patchShaPath,
        `${sha ?? createHash('sha256').update(text).digest('hex')}  patch.diff\n`,
      )
    },
    async writeReport(r) {
      await fs.writeFile(world.args.reportPath, JSON.stringify(r))
    },
    async inputs() {
      return JSON.parse(
        await fs.readFile(path.join(runDir, 'verdict-inputs.json'), 'utf8'),
      ) as Json
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }

  const gitFake = async (args: string[], opts?: ExecOptions) => {
    const cwd = opts?.cwd ?? ''
    if (args[0] === 'rev-parse') return ok(`${world.head}\n`)
    if (args[0] === 'status') {
      const now = new Map<string, string>()
      for (const f of await walk(cwd))
        now.set(f, await fs.readFile(path.join(cwd, f), 'utf8'))
      const out: string[] = []
      for (const [f, text] of now)
        if (!initial.has(f)) out.push(`?? ${f}`)
        else if (initial.get(f) !== text) out.push(` M ${f}`)
      for (const f of initial.keys())
        if (!now.has(f) && !f.includes('node_modules')) out.push(` D ${f}`)
      return ok(out.map((e) => `${e}\0`).join(''))
    }
    if (args[0] === 'apply') {
      const text = await fs.readFile(args.at(-1)!, 'utf8')
      for (const d of parseUnifiedDiff(text)) {
        const target = path.join(cwd, d.newPath!)
        await fs.mkdir(path.dirname(target), { recursive: true })
        const lines =
          d.status === 'added'
            ? []
            : (await fs.readFile(target, 'utf8')).split('\n').slice(0, -1)
        for (const a of d.added) lines.splice(a.line - 1, 0, a.text)
        await fs.writeFile(target, `${lines.join('\n')}\n`)
      }
      await world.onApply(cwd)
      return ok()
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  }

  const dockerFake = async (args: string[]): Promise<ExecResult> => {
    const mounts = args.flatMap((a, i) => (args[i - 1] === '-v' ? [a] : []))
    const appDir = mounts
      .find((m) => m.endsWith(':/app'))!
      .slice(0, -':/app'.length)
    const resultsDir = mounts
      .find((m) => m.endsWith(':/results'))!
      .slice(0, -':/results'.length)
    const w = args.indexOf('-w')
    const run: DockerRun = {
      step: path.basename(resultsDir),
      argv: args,
      appDir,
      resultsDir,
      command: args.slice(w + 3),
      testFiles: (await walk(appDir)).filter((f) => /\.test\.tsx?$/.test(f)),
    }
    world.docker.push(run)
    const r = await world.onDocker(run, () => defaultDocker(run))
    if (r.json)
      await fs.writeFile(
        path.join(resultsDir, 'run.json'),
        JSON.stringify(r.json),
      )
    if (r.coverage) {
      await fs.mkdir(path.join(resultsDir, 'run-coverage'), { recursive: true })
      await fs.writeFile(
        path.join(resultsDir, 'run-coverage/coverage-final.json'),
        JSON.stringify(r.coverage),
      )
    }
    return {
      code: r.code,
      stdout: `out of ${run.step}`,
      stderr: `err of ${run.step}`,
      timedOut: false,
    }
  }

  world.deps = {
    fs,
    image: 'node:22@sha256:test',
    user: '1001:1001',
    exec: async (cmd, args, opts) => {
      world.calls.push({ cmd, args, opts })
      if (cmd === 'git') return gitFake(args, opts)
      if (cmd === 'docker' && args[0] === 'run') return dockerFake(args)
      if (cmd === 'docker' && args[0] === 'kill') return ok()
      throw new Error(`unexpected exec ${cmd}`)
    },
  }

  await world.writePatch(addedFileDiff(NEW_TEST, NEW_TEST_TEXT))
  await world.writeReport(report())
  await fs.writeFile(
    world.args.transcriptPath,
    [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
          ],
        },
      },
      { type: 'result', subtype: 'success', total_cost_usd: 0.5, num_turns: 3 },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n'),
  )
  await fs.writeFile(
    world.args.guardLogPath,
    `${JSON.stringify({ tool_use_id: 'toolu_1', tool_name: 'Read', allow: true })}\n`,
  )
  return world
}
