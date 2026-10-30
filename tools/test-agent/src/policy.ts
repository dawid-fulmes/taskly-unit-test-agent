import { readFileSync } from 'node:fs'
import picomatch from 'picomatch'
import type { App } from './types.ts'

export interface Policy {
  testGlobs: Record<App, string[]>
  evidenceGlobs: Record<App, string[]>
  sourceGlobs: Record<App, string[]>
  sourceIgnore: string[]
  configGlobs: string[]
  dependencyFiles: string[]
  secretGlobs: string[]
  skipMinChangedLineCoverage: number
  forbiddenTestCalls: string[]
  forbiddenAssertions: string[]
  /** The Prisma schema the backend generates its client from (repo-relative). */
  prismaSchemaPath: string
  /** Built-in Prisma generator providers; anything else is code a PR could make `prisma generate` run. */
  allowedPrismaGenerators: string[]
}

const DEFAULT_POLICY_FILE = new URL('../policy.json', import.meta.url)

export function loadPolicy(file?: string): Policy {
  return JSON.parse(readFileSync(file ?? DEFAULT_POLICY_FILE, 'utf8')) as Policy
}

const OPTIONS = { dot: true }
const EVIDENCE_IGNORE = '**/__evidence__/**'

export function appOf(path: string): App | null {
  if (path.startsWith('backend/')) return 'backend'
  if (path.startsWith('frontend/')) return 'frontend'
  return null
}

function matchesAny(globs: string[], path: string, ignore: string[] = []) {
  return (
    picomatch.isMatch(path, globs, { ...OPTIONS, ignore }) &&
    !picomatch.isMatch(path, ignore, OPTIONS)
  )
}

function allApps(globs: Record<App, string[]>): string[] {
  return [...globs.backend, ...globs.frontend]
}

/** Committed test files. Evidence files are deliberately excluded (see isEvidencePath). */
export function isTestPath(policy: Policy, path: string): boolean {
  return matchesAny(allApps(policy.testGlobs), path, [EVIDENCE_IGNORE])
}

export function isEvidencePath(policy: Policy, path: string): boolean {
  return matchesAny(allApps(policy.evidenceGlobs), path)
}

export function isSourcePath(policy: Policy, path: string): boolean {
  return matchesAny(allApps(policy.sourceGlobs), path, policy.sourceIgnore)
}

export function isConfigPath(policy: Policy, path: string): boolean {
  return matchesAny(policy.configGlobs, path)
}

/** Secret globs may contain `!negated` entries that re-allow a path. */
export function isSecretPath(policy: Policy, path: string): boolean {
  const positive = policy.secretGlobs.filter((g) => !g.startsWith('!'))
  const negated = policy.secretGlobs
    .filter((g) => g.startsWith('!'))
    .map((g) => g.slice(1))
  return matchesAny(positive, path, negated)
}
