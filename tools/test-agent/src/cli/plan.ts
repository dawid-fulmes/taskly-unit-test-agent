import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

// Fail closed: node: built-ins only are imported statically; everything else loads inside try.
try {
  const { exec } = await import('../exec.ts')
  const { loadPolicy } = await import('../policy.ts')
  const { buildPlan, renamedIntoSource } = await import('../plan.ts')
  const { readCoverageExcludes } = await import('../config-excludes.ts')
  const { buildBackfillPlan, normalizeCoverage } =
    await import('../coverage.ts')

  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      'pr-json': { type: 'string' },
      trusted: { type: 'string' },
      work: { type: 'string' },
      out: { type: 'string' },
      app: { type: 'string' },
      'max-files': { type: 'string' },
      coverage: { type: 'string' },
    },
    strict: true,
  })
  const need = (k: keyof typeof values): string => {
    const v = values[k]
    if (typeof v !== 'string' || v === '') throw new Error(`missing --${k}`)
    return v
  }
  const mode = need('mode')
  if (mode !== 'pr' && mode !== 'backfill')
    throw new Error('--mode must be pr or backfill')
  const base = need('base')
  const trusted = need('trusted')
  const readExcludes = (app: 'backend' | 'frontend') =>
    readCoverageExcludes(
      readFileSync(
        join(
          trusted,
          app === 'backend'
            ? 'backend/vitest.config.ts'
            : 'frontend/vite.config.ts',
        ),
        'utf8',
      ),
    )

  if (mode === 'backfill') {
    const app = need('app')
    if (app !== 'backend' && app !== 'frontend')
      throw new Error(`unknown --app: ${app}`)
    const maxFiles = Number(need('max-files'))
    if (!Number.isInteger(maxFiles) || maxFiles < 1)
      throw new Error('--max-files must be a positive integer')
    const raw = JSON.parse(readFileSync(need('coverage'), 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new Error('invalid --coverage')
    const plan = buildBackfillPlan({
      cov: normalizeCoverage(raw, '/app', app),
      app,
      policy: loadPolicy(),
      maxFiles,
      excludes: readExcludes(app),
      baseSha: base,
    })
    writeFileSync(need('out'), `${JSON.stringify(plan, null, 2)}\n`)
    process.exit(0)
  }

  const head = need('head')
  const work = need('work')

  const git = async (...args: string[]) => {
    const r = await exec('git', args, { cwd: work })
    if (r.code !== 0 || r.timedOut)
      throw new Error(`git ${args[0]} failed (code ${r.code}): ${r.stderr}`)
    return r.stdout
  }
  const mergeBase = (await git('merge-base', base, head)).trim()
  const diffText = await git(
    'diff',
    '--unified=0',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    '--text',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    mergeBase,
    head,
  )
  const pr = JSON.parse(readFileSync(need('pr-json'), 'utf8'))
  if (
    pr === null ||
    typeof pr.number !== 'number' ||
    typeof pr.title !== 'string' ||
    typeof pr.body !== 'string' ||
    typeof pr.draft !== 'boolean' ||
    !Array.isArray(pr.labels) ||
    !pr.labels.every((l: unknown) => typeof l === 'string')
  )
    throw new Error('invalid --pr-json')

  const policy = loadPolicy()
  const newFileLineCounts: Record<string, number> = {}
  for (const path of renamedIntoSource(diffText, policy)) {
    const text = await git('show', `${head}:${path}`)
    newFileLineCounts[path] =
      text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  }

  const plan = buildPlan({
    newFileLineCounts,
    mode: 'pr',
    policy,
    diffText,
    pr,
    baseSha: base,
    headSha: head,
    baseExcludes: {
      backend: readExcludes('backend'),
      frontend: readExcludes('frontend'),
    },
  })
  writeFileSync(need('out'), `${JSON.stringify(plan, null, 2)}\n`)
} catch (error) {
  process.stderr.write(
    `plan failure: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
