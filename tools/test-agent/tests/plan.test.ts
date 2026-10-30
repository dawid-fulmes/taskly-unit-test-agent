import {
  mkdirSync,
  renameSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exec } from '../src/exec.ts'
import { buildPlan, type PlanInput } from '../src/plan.ts'
import { loadPolicy } from '../src/policy.ts'

function modified(path: string, hunk = '@@ -1,0 +2,1 @@\n+x\n'): string {
  return `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${hunk}`
}

function input(diffText: string, over: Partial<PlanInput> = {}): PlanInput {
  return {
    mode: 'pr',
    policy: loadPolicy(),
    diffText,
    pr: { number: 7, title: 'T', body: 'B', draft: false, labels: [] },
    baseSha: 'b',
    headSha: 'h',
    baseExcludes: {
      backend: ['src/generated/**'],
      frontend: ['src/design-system/**'],
    },
    ...over,
  }
}

describe('buildPlan', () => {
  it('README only is nothing-to-test', () => {
    const p = buildPlan(input(modified('README.md')))
    expect(p.earlyOutcome).toBe('nothing-to-test')
    expect(p.manifest).toEqual([])
    expect(p.prNumber).toBe(7)
    expect(p.budgetProfile).toBe('default')
  })
  it('draft wins over config change', () => {
    const p = buildPlan(
      input(modified('frontend/vite.config.ts'), {
        pr: { number: 1, title: '', body: '', draft: true, labels: [] },
      }),
    )
    expect(p.earlyOutcome).toBe('draft')
  })
  it('config change stops', () => {
    const p = buildPlan(input(modified('frontend/vite.config.ts')))
    expect(p.earlyOutcome).toBe('config-changed')
  })
  it('dependencies and exact lines', () => {
    const p = buildPlan(
      input(
        modified('backend/package-lock.json') +
          modified(
            'backend/src/router.ts',
            '@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-c\n+d\n',
          ),
      ),
    )
    expect(p.dependenciesChanged).toBe(true)
    expect(p.earlyOutcome).toBeNull()
    expect(p.manifest).toEqual([
      {
        path: 'backend/src/router.ts',
        app: 'backend',
        status: 'modified',
        changedLines: [4, 5, 12],
        excludedOnBase: false,
      },
    ])
  })
  it('flags excludedOnBase relative to the app dir', () => {
    const p = buildPlan(
      input(modified('frontend/src/design-system/components/Badge/Badge.tsx')),
    )
    expect(p.manifest).toHaveLength(1)
    expect(p.manifest[0]?.excludedOnBase).toBe(true)
  })
  it('skips stories, tests and deleted files', () => {
    const del = `diff --git a/backend/src/old.ts b/backend/src/old.ts\ndeleted file mode 100644\nindex 1..0\n--- a/backend/src/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n`
    const p = buildPlan(
      input(
        modified('frontend/src/A.stories.tsx') +
          modified('frontend/src/A.test.tsx') +
          del,
      ),
    )
    expect(p.manifest).toEqual([])
    expect(p.earlyOutcome).toBe('nothing-to-test')
  })
  it('handles renames, binary files and CRLF content', () => {
    const rename = `diff --git a/backend/src/a.ts b/backend/src/b.ts\nsimilarity index 90%\nrename from backend/src/a.ts\nrename to backend/src/b.ts\nindex 1..2 100644\n--- a/backend/src/a.ts\n+++ b/backend/src/b.ts\n@@ -1,0 +2,1 @@\n+x\r\n`
    const bin = `diff --git a/frontend/src/i.png b/frontend/src/i.png\nindex 1..2 100644\nBinary files a/frontend/src/i.png and b/frontend/src/i.png differ\n`
    const p = buildPlan(input(rename + bin + modified('backend/src/c.ts')))
    expect(p.manifest.map((m) => [m.path, m.status, m.changedLines])).toEqual([
      ['backend/src/b.ts', 'renamed', [2]],
      ['backend/src/c.ts', 'modified', [2]],
    ])
  })
  it('reports tests removed by the author and the large budget label', () => {
    const t = modified(
      'backend/tests/a.test.ts',
      "@@ -1,1 +0,0 @@\n-  it('x', () => {})\n",
    )
    const p = buildPlan(
      input(t + modified('backend/src/a.ts'), {
        pr: {
          number: 1,
          title: '',
          body: '',
          draft: false,
          labels: ['test-agent:retry-large'],
        },
      }),
    )
    expect(p.testsRemovedByAuthor).toEqual([
      { file: 'backend/tests/a.test.ts', count: 1 },
    ])
    expect(p.budgetProfile).toBe('large')
  })
})

describe('buildPlan fail-closed', () => {
  it('throws on a binary section for a source path', () => {
    const bin =
      'diff --git a/backend/src/a.ts b/backend/src/a.ts\nindex 1..2 100644\nBinary files a/backend/src/a.ts and b/backend/src/a.ts differ\n'
    expect(() => buildPlan(input(bin))).toThrow(/binary/)
  })
  it('throws on a truncated source hunk', () => {
    const bad = `diff --git a/backend/src/a.ts b/backend/src/a.ts\nindex 1..2 100644\n--- a/backend/src/a.ts\n+++ b/backend/src/a.ts\n@@ -1,0 +2,3 @@\n+x\n`
    expect(() => buildPlan(input(bad))).toThrow()
  })
  it('throws on garbage before the first section', () => {
    expect(() => buildPlan(input('junk\n' + modified('README.md')))).toThrow()
  })
  it('handles filenames with spaces, quotes and unicode', () => {
    const p = buildPlan(
      input(
        modified('backend/src/my file.ts') +
          modified('"backend/src/caf\\303\\251.ts"'.slice(1, -1)).replace(
            /backend\/src\/caf\\303\\251\.ts/g,
            'backend/src/caf\\303\\251.ts',
          ),
      ),
    )
    expect(p.manifest.map((m) => m.path)).toContain('backend/src/my file.ts')
  })
  it('renames into a source path become added with all lines', () => {
    const r = `diff --git a/docs/x.ts b/backend/src/x.ts\nsimilarity index 100%\nrename from docs/x.ts\nrename to backend/src/x.ts\n`
    expect(() => buildPlan(input(r))).toThrow(/line count/)
    const p = buildPlan(
      input(r, { newFileLineCounts: { 'backend/src/x.ts': 3 } }),
    )
    expect(p.manifest[0]).toMatchObject({
      status: 'added',
      changedLines: [1, 2, 3],
    })
  })
  it('pure rename within source is skipped', () => {
    const r = `diff --git a/backend/src/x.ts b/backend/src/y.ts\nsimilarity index 100%\nrename from backend/src/x.ts\nrename to backend/src/y.ts\n`
    expect(buildPlan(input(r)).earlyOutcome).toBe('nothing-to-test')
  })
})

describe('plan CLI', () => {
  it('writes plan.json from a real git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-cli-'))
    const git = (...a: string[]) =>
      exec('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=n', ...a], {
        cwd: dir,
      })
    await git('init', '-q', '-b', 'main')
    mkdirSync(join(dir, 'backend/src'), { recursive: true })
    writeFileSync(join(dir, 'backend/src/a.ts'), 'a\nb\n')
    mkdirSync(join(dir, 'backend/tests/__evidence__'), { recursive: true })
    writeFileSync(join(dir, 'backend/tests/a.test.ts'), 'x\n')
    writeFileSync(join(dir, 'backend/tests/__evidence__/e.test.ts'), 'x\n')
    writeFileSync(join(dir, 'backend/tests/fixture.ts'), 'x\n')
    await git('add', '.')
    await git('commit', '-qm', 'base')
    const base = (await git('rev-parse', 'HEAD')).stdout.trim()
    writeFileSync(join(dir, 'backend/src/a.ts'), 'a\nb\nc\r\n')
    await git('commit', '-qam', 'head')
    const head = (await git('rev-parse', 'HEAD')).stdout.trim()
    const trusted = join(dir, 'trusted')
    mkdirSync(join(trusted, 'backend'), { recursive: true })
    mkdirSync(join(trusted, 'frontend'), { recursive: true })
    const cfg = (e: string) =>
      `export default { test: { coverage: { exclude: ['${e}'] } } }`
    writeFileSync(join(trusted, 'backend/vitest.config.ts'), cfg('src/g/**'))
    writeFileSync(join(trusted, 'frontend/vite.config.ts'), cfg('src/d/**'))
    const prJson = join(dir, 'pr.json')
    writeFileSync(
      prJson,
      JSON.stringify({
        number: 3,
        title: 't',
        body: 'b',
        draft: false,
        labels: [],
      }),
    )
    const out = join(dir, 'plan.json')
    const cli = new URL('../src/cli/plan.ts', import.meta.url).pathname
    const r = await exec('node', [
      cli,
      '--mode',
      'pr',
      '--base',
      base,
      '--head',
      head,
      '--pr-json',
      prJson,
      '--trusted',
      trusted,
      '--work',
      dir,
      '--out',
      out,
    ])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const plan = JSON.parse(readFileSync(out, 'utf8'))
    expect(plan.manifest[0].path).toBe('backend/src/a.ts')
    expect(plan.manifest[0].changedLines).toEqual([3])
    // Discovery aid for the agent: existing test files on head (evidence and helpers excluded).
    expect(plan.testFiles).toEqual(['backend/tests/a.test.ts'])
    const bad = await exec('node', [cli, '--mode', 'pr'])
    expect(bad.code).not.toBe(0)
  })

  async function repo(
    setup: (dir: string) => void,
    change: (dir: string) => void,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'plan-cli-'))
    const git = (...a: string[]) =>
      exec('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=n', ...a], {
        cwd: dir,
      })
    await git('init', '-q', '-b', 'main')
    setup(dir)
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    const base = (await git('rev-parse', 'HEAD')).stdout.trim()
    change(dir)
    await git('add', '-A')
    await git('commit', '-qm', 'head')
    const head = (await git('rev-parse', 'HEAD')).stdout.trim()
    const trusted = join(dir, '..', `${dir.split('/').pop()}-trusted`)
    mkdirSync(join(trusted, 'backend'), { recursive: true })
    mkdirSync(join(trusted, 'frontend'), { recursive: true })
    const cfg = "export default { test: { coverage: { exclude: ['x/**'] } } }"
    writeFileSync(join(trusted, 'backend/vitest.config.ts'), cfg)
    writeFileSync(join(trusted, 'frontend/vite.config.ts'), cfg)
    const prJson = join(trusted, 'pr.json')
    writeFileSync(
      prJson,
      JSON.stringify({
        number: 3,
        title: 't',
        body: 'b',
        draft: false,
        labels: [],
      }),
    )
    const out = join(trusted, 'plan.json')
    const cli = new URL('../src/cli/plan.ts', import.meta.url).pathname
    const r = await exec('node', [
      cli,
      '--mode',
      'pr',
      '--base',
      base,
      '--head',
      head,
      '--pr-json',
      prJson,
      '--trusted',
      trusted,
      '--work',
      dir,
      '--out',
      out,
    ])
    return { r, out }
  }

  it('binary-flagged source (-diff attribute) still yields a manifest entry', async () => {
    const { r, out } = await repo(
      (d) => {
        mkdirSync(join(d, 'backend/src'), { recursive: true })
        writeFileSync(join(d, 'backend/src/a.ts'), 'a\n')
      },
      (d) => {
        writeFileSync(join(d, '.gitattributes'), '*.ts -diff\n')
        writeFileSync(join(d, 'backend/src/a.ts'), 'a\nb\n')
      },
    )
    expect(r.stderr).toBe('')
    expect(
      JSON.parse(readFileSync(out, 'utf8')).manifest[0].changedLines,
    ).toEqual([2])
  })
  it('NUL byte in source still yields a manifest entry', async () => {
    const { r, out } = await repo(
      (d) => {
        mkdirSync(join(d, 'backend/src'), { recursive: true })
        writeFileSync(join(d, 'backend/src/a.ts'), 'a\n')
      },
      (d) => writeFileSync(join(d, 'backend/src/a.ts'), 'a\n\0b\n'),
    )
    expect(r.code).toBe(0)
    expect(
      JSON.parse(readFileSync(out, 'utf8')).manifest[0].changedLines,
    ).toEqual([2])
  })
  it('rename into source and odd filenames work end to end', async () => {
    const { r, out } = await repo(
      (d) => {
        mkdirSync(join(d, 'docs'), { recursive: true })
        mkdirSync(join(d, 'backend/src'), { recursive: true })
        writeFileSync(join(d, 'docs/x.ts'), '1\n2\n3\n')
      },
      (d) => {
        renameSync(join(d, 'docs/x.ts'), join(d, 'backend/src/x.ts'))
        writeFileSync(join(d, 'backend/src/we ird "q" caf\u00e9.ts'), 'z\n')
      },
    )
    expect(r.stderr).toBe('')
    const m = JSON.parse(readFileSync(out, 'utf8')).manifest
    expect(m).toHaveLength(2)
    expect(
      m.find((e: { path: string }) => e.path === 'backend/src/x.ts'),
    ).toMatchObject({
      status: 'added',
      changedLines: [1, 2, 3],
    })
    expect(m.map((e: { path: string }) => e.path)).toContain(
      'backend/src/we ird "q" caf\u00e9.ts',
    )
  })
})

describe('plan CLI backfill', () => {
  it('lists existing test files from the trusted tree', async () => {
    const trusted = mkdtempSync(join(tmpdir(), 'plan-bf-'))
    const cfg = "export default { test: { coverage: { exclude: ['x/**'] } } }"
    mkdirSync(join(trusted, 'backend/tests/__evidence__'), { recursive: true })
    mkdirSync(join(trusted, 'backend/node_modules/pkg/tests'), {
      recursive: true,
    })
    mkdirSync(join(trusted, 'frontend/src/a'), { recursive: true })
    writeFileSync(join(trusted, 'backend/vitest.config.ts'), cfg)
    writeFileSync(join(trusted, 'frontend/vite.config.ts'), cfg)
    writeFileSync(join(trusted, 'backend/tests/r.test.ts'), 'x\n')
    writeFileSync(join(trusted, 'backend/tests/__evidence__/e.test.ts'), 'x\n')
    writeFileSync(join(trusted, 'backend/node_modules/pkg/tests/n.test.ts'), 'x\n')
    writeFileSync(join(trusted, 'frontend/src/a/B.test.tsx'), 'x\n')
    const coverage = join(trusted, 'coverage.json')
    writeFileSync(
      coverage,
      JSON.stringify({
        '/app/src/x.ts': {
          path: '/app/src/x.ts',
          statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
          s: { '0': 0 },
        },
      }),
    )
    const out = join(trusted, 'plan.json')
    const cli = new URL('../src/cli/plan.ts', import.meta.url).pathname
    const r = await exec('node', [
      cli,
      '--mode',
      'backfill',
      '--app',
      'backend',
      '--max-files',
      '8',
      '--coverage',
      coverage,
      '--trusted',
      trusted,
      '--base',
      'a'.repeat(40),
      '--out',
      out,
    ])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    const plan = JSON.parse(readFileSync(out, 'utf8'))
    expect(plan.testFiles).toEqual([
      'backend/tests/r.test.ts',
      'frontend/src/a/B.test.tsx',
    ])
  })
})
