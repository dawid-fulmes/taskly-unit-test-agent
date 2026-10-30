import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

// Fail closed: node: built-ins only are imported statically; everything else loads inside try.
try {
  const { exec } = await import('../exec.ts')
  const { loadPolicy } = await import('../policy.ts')
  const { buildPlan } = await import('../plan.ts')
  const { readCoverageExcludes } = await import('../config-excludes.ts')

  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      'pr-json': { type: 'string' },
      trusted: { type: 'string' },
      work: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  })
  const need = (k: keyof typeof values): string => {
    const v = values[k]
    if (typeof v !== 'string' || v === '') throw new Error(`missing --${k}`)
    return v
  }
  if (need('mode') !== 'pr') throw new Error('only --mode pr is supported')
  const base = need('base')
  const head = need('head')
  const work = need('work')
  const trusted = need('trusted')

  const git = async (...args: string[]) => {
    const r = await exec('git', args, { cwd: work })
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`)
    return r.stdout
  }
  const mergeBase = (await git('merge-base', base, head)).trim()
  const diffText = await git(
    'diff',
    '--unified=0',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
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
    !Array.isArray(pr.labels)
  )
    throw new Error('invalid --pr-json')

  const plan = buildPlan({
    mode: 'pr',
    policy: loadPolicy(),
    diffText,
    pr,
    baseSha: base,
    headSha: head,
    baseExcludes: {
      backend: readCoverageExcludes(
        readFileSync(join(trusted, 'backend/vitest.config.ts'), 'utf8'),
      ),
      frontend: readCoverageExcludes(
        readFileSync(join(trusted, 'frontend/vite.config.ts'), 'utf8'),
      ),
    },
  })
  writeFileSync(need('out'), `${JSON.stringify(plan, null, 2)}\n`)
} catch (error) {
  process.stderr.write(
    `plan failure: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
