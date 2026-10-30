import path from 'node:path'
import { parseUnifiedDiff, splitSections } from '../diff.ts'
import { appOf, isTestPath, type Policy } from '../policy.ts'
import type { App } from '../types.ts'
import type { Fs } from './sandbox.ts'

// Vitest never collects from these (its default exclude), so the walk skips them too.
const SKIP_DIRS = new Set(['node_modules', '.git'])

/**
 * ADR 0012 discovery: the base test globs (evidence excluded) applied to the work tree.
 * Repo-relative POSIX paths (ruling R2), sorted. Symlinks are not followed.
 */
export async function expectedFiles(
  fs: Fs,
  workDir: string,
  app: App,
  policy: Policy,
): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(workDir, rel), {
      withFileTypes: true,
    })
    for (const e of entries) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(child)
      } else if (
        e.isFile() &&
        isTestPath(policy, child) &&
        appOf(child) === app
      )
        out.push(child)
    }
  }
  await walk(app)
  return out.sort()
}

/** The raw diff sections that touch `file` (byte-identical), for applying one evidence file alone. */
export function sectionsFor(diffText: string, file: string): string {
  const { sections } = splitSections(diffText)
  const all = parseUnifiedDiff(diffText)
  const parsed = all.slice(all.length - sections.length)
  return sections
    .filter((_, i) => {
      const d = parsed[i]!
      return d.oldPath === file || d.newPath === file
    })
    .map((s) => s.raw)
    .join('')
}
