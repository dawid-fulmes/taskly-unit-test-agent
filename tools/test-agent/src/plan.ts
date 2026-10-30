import picomatch from 'picomatch'
import { parseUnifiedDiff, changedLines } from './diff.ts'
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
}

/**
 * The plan diff is the PR author's own diff from our `git diff`, so CRs (CRLF files) and
 * Unicode line separators in content are legitimate. git counts lines by LF only, so
 * stripping them keeps line numbers exact while letting the strict parser accept the text.
 * Malformed flags are ignored here: the strict gates run on agent patches, not on this diff.
 */
export function readPlanDiff(diffText: string) {
  const clean = diffText.replace(/[\r\u2028\u2029]/g, '')
  return parseUnifiedDiff(clean).filter(
    (d) => d.oldPath !== null || d.newPath !== null,
  )
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
    if (d.status === 'deleted' || d.newPath === null || d.binary) continue
    if (!isSourcePath(policy, d.newPath)) continue
    const app = appOf(d.newPath)
    if (app === null) continue
    const lines = changedLines(d)
    if (lines.length === 0) continue
    manifest.push({
      path: d.newPath,
      app,
      status: d.status,
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
