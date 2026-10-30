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

function excludedOnBase(path: string, app: App, globs: string[]): boolean {
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
    : touched.some((p) => isConfigPath(policy, p))
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
