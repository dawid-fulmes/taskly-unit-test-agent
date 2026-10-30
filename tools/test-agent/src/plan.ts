import picomatch from 'picomatch'
import { parseUnifiedDiff, changedLines, type FileDiff } from './diff.ts'
import { testsRemoved } from './gates.ts'
import { appOf, isConfigPath, isSourcePath, type Policy } from './policy.ts'
import type { App, ManifestEntry, Mode, Plan } from './types.ts'

export interface PlanInput {
  mode: Mode
  policy: Policy
  diffText: string
  pr: {
    number: number
    title: string
    body: string
    draft: boolean
    labels: string[]
  } | null
  baseSha: string
  headSha: string
  baseExcludes: Record<App, string[]>
  /** Line counts of head files that were renamed into a source path from a non-source origin (see renamedIntoSource). */
  newFileLineCounts?: Record<string, number>
  /** Head content of policy.prismaSchemaPath (null when absent); omitted skips the check. */
  prismaSchema?: string | null
}

/** Removes `//` comments (Prisma's only comment syntax) outside double-quoted strings. */
function stripPrismaComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let quoted = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (c === '\\' && quoted) i++
        else if (c === '"') quoted = !quoted
        else if (!quoted && c === '/' && line[i + 1] === '/')
          return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

/**
 * A Prisma generator's provider is a command `prisma generate` runs. Only the built-in clients are
 * allowed; anything else (a custom command, env(), several generators of other kinds) is reported
 * so the run stops as config-changed for human review. Null when the schema is acceptable.
 */
export function prismaGeneratorProblem(
  schema: string | null,
  allowed: string[],
): string | null {
  if (schema === null) return 'prisma schema missing on head'
  const text = stripPrismaComments(schema)
  const keywords = text.match(/^\s*generator\b/gm)?.length ?? 0
  const blocks = [...text.matchAll(/^\s*generator\s+\w+\s*\{([^{}]*)\}/gm)]
  if (keywords === 0) return 'prisma schema has no generator'
  if (blocks.length !== keywords)
    return 'prisma generator block could not be parsed'
  for (const [, body] of blocks) {
    const providers = [...body.matchAll(/^\s*provider\s*=\s*(.*?)\s*$/gm)]
    if (providers.length !== 1)
      return 'prisma generator must set exactly one provider'
    const value = /^"([^"\\]*)"$/.exec(providers[0][1])?.[1]
    if (value === undefined || !allowed.includes(value))
      return `prisma generator provider not allowed: ${providers[0][1].slice(0, 80)}`
  }
  return null
}

/**
 * The plan diff is the PR author's own diff from our `git diff`, so CRs (CRLF files) and
 * Unicode line separators in content are legitimate. git counts lines by LF only, so
 * stripping them keeps line numbers exact while letting the strict parser accept the text.
 * Malformed flags are ignored here: the strict gates run on agent patches, not on this diff.
 */
export function readPlanDiff(diffText: string): FileDiff[] {
  const clean = diffText.replace(/[\r\u2028\u2029]/g, '')
  const diffs = parseUnifiedDiff(clean)
  for (const d of diffs) {
    // A duplicate path (rename plus new file at the old name, typechange) is legitimate in a PR diff.
    if (d.malformed !== null && !DUPLICATE_PATH.test(d.malformed))
      throw new Error(`unreadable diff section: ${d.malformed}`)
    if (d.oldPath === null && d.newPath === null)
      throw new Error('unreadable diff section: no paths')
  }
  return diffs
}

const DUPLICATE_PATH = /^path appears in more than one section/

/** Destinations of renames whose origin is not a source path; the plan treats them as newly added files. */
export function renamedIntoSource(diffText: string, policy: Policy): string[] {
  return readPlanDiff(diffText)
    .filter(
      (d) =>
        d.status === 'renamed' &&
        d.newPath !== null &&
        isSourcePath(policy, d.newPath) &&
        (d.oldPath === null || !isSourcePath(policy, d.oldPath)),
    )
    .map((d) => d.newPath as string)
}

export function excludedOnBase(
  path: string,
  app: App,
  globs: string[],
): boolean {
  const rel = path.slice(app.length + 1)
  return globs.length > 0 && picomatch(globs, { dot: true })(rel)
}

export function buildPlan(input: PlanInput): Plan {
  const { policy, pr } = input
  const diffs = readPlanDiff(input.diffText)
  const touched = diffs.flatMap((d) =>
    [d.oldPath, d.newPath].filter((p): p is string => p !== null),
  )

  const manifest: ManifestEntry[] = []
  for (const d of diffs) {
    const isSrc = (p: string | null) => p !== null && isSourcePath(policy, p)
    if (d.binary && (isSrc(d.newPath) || isSrc(d.oldPath)))
      throw new Error(
        `binary diff section on a source path: ${d.newPath ?? d.oldPath}`,
      )
    if (d.status === 'deleted' || d.newPath === null || d.binary) continue
    if (!isSrc(d.newPath)) continue
    const app = appOf(d.newPath)
    if (app === null) continue
    let status: ManifestEntry['status'] = d.status
    let lines = changedLines(d)
    if (d.status === 'renamed' && !isSrc(d.oldPath)) {
      const count = input.newFileLineCounts?.[d.newPath]
      if (count === undefined)
        throw new Error(`missing line count for renamed-in file: ${d.newPath}`)
      status = 'added'
      lines = Array.from({ length: count }, (_, i) => i + 1)
    }
    if (lines.length === 0) continue
    manifest.push({
      path: d.newPath,
      app,
      status,
      changedLines: lines,
      excludedOnBase: excludedOnBase(d.newPath, app, input.baseExcludes[app]),
    })
  }

  const draft = pr?.draft ?? false
  const earlyOutcome: Plan['earlyOutcome'] = draft
    ? 'draft'
    : touched.some((p) => isConfigPath(policy, p)) ||
        (input.prismaSchema !== undefined &&
          prismaGeneratorProblem(
            input.prismaSchema,
            policy.allowedPrismaGenerators,
          ) !== null)
      ? 'config-changed'
      : manifest.length === 0
        ? 'nothing-to-test'
        : null

  return {
    mode: input.mode,
    prNumber: pr?.number ?? null,
    baseSha: input.baseSha,
    headSha: input.headSha,
    title: pr?.title ?? '',
    description: pr?.body ?? '',
    draft,
    earlyOutcome,
    manifest,
    dependenciesChanged: touched.some((p) =>
      policy.dependencyFiles.includes(p),
    ),
    testsRemovedByAuthor: testsRemoved(diffs, policy),
    budgetProfile: pr?.labels.includes('test-agent:retry-large')
      ? 'large'
      : 'default',
  }
}
