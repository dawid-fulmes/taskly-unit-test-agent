import path from 'node:path'
import { normalizeCoverage, type CoverageMap } from '../coverage.ts'
import type { App } from '../types.ts'
import { readVitestJson, type RunSummary } from '../vitest-results.ts'
import type { Fs } from './sandbox.ts'

export type ParsedRun =
  | { ok: true; summary: RunSummary; coverage: CoverageMap | null }
  | { ok: false; error: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The results dir is writable by the container (PR code), so a result file may be a symlink
 * to a host path. Only regular files are read, and parse errors never echo file content.
 */
async function readRegularJson(fs: Fs, file: string): Promise<unknown> {
  let stat
  try {
    stat = await fs.lstat(file)
  } catch {
    throw new Error(`${path.basename(file)} missing`)
  }
  if (!stat.isFile())
    throw new Error(`${path.basename(file)} is not a regular file`)
  const text = await fs.readFile(file, 'utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${path.basename(file)} is not valid JSON`)
  }
}

const isLine = (v: unknown) =>
  isRecord(v) && typeof v.line === 'number' && Number.isInteger(v.line)

/** Shape check for what coverage.ts reads (statement map lines and hit counts). */
function checkCoverageShape(raw: unknown): CoverageMap {
  if (!isRecord(raw)) throw new Error('coverage is not an object')
  for (const [key, entry] of Object.entries(raw)) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.statementMap) ||
      !isRecord(entry.s) ||
      !Object.values(entry.statementMap).every(
        (st) => isRecord(st) && isLine(st.start) && isLine(st.end),
      ) ||
      !Object.values(entry.s).every((n) => typeof n === 'number')
    )
      throw new Error(`malformed coverage entry ${JSON.stringify(key)}`)
  }
  return raw as CoverageMap
}

/** Reads `<name>.json` (and `<name>-coverage/coverage-final.json`) from a step's results dir. */
export async function readRun(
  fs: Fs,
  resultsDir: string,
  name: string,
  app: App,
  coverage: boolean,
): Promise<ParsedRun> {
  try {
    const summary = readVitestJson(
      await readRegularJson(fs, path.join(resultsDir, `${name}.json`)),
      app,
    )
    if (!coverage) return { ok: true, summary, coverage: null }
    const dir = path.join(resultsDir, `${name}-coverage`)
    const dirStat = await fs.lstat(dir).catch(() => null)
    if (!dirStat?.isDirectory())
      throw new Error('coverage directory missing or not a directory')
    const raw = checkCoverageShape(
      await readRegularJson(fs, path.join(dir, 'coverage-final.json')),
    )
    return {
      ok: true,
      summary,
      coverage: normalizeCoverage(raw, '/app', app),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
