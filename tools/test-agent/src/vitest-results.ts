import type { App } from './types.ts'

export type TestStatus =
  'passed' | 'failed' | 'skipped' | 'todo' | 'pending' | (string & {})

export interface RunSummary {
  files: string[]
  total: number
  passed: number
  failed: number
  failures: {
    file: string
    name: string
    isAssertion: boolean
    message: string
  }[]
  /** Every test case with its full name (describe chain included). */
  tests: { file: string; name: string; status: TestStatus }[]
  skipped: number
  todo: number
  passedByFile: Record<string, number>
  /**
   * Tests declared with `it.fails` / `test.fails`. Always empty: Vitest's JSON reporter reports
   * them as plain "passed" with empty `meta`, so fails-mode is not observable from it.
   */
  failsMode: { file: string; name: string }[]
}

export const LOAD_FAILURE_NAME = '(file failed to load)'

const CONTAINER_ROOT = '/app/'

function fail(msg: string): never {
  throw new Error(`unreadable vitest json: ${msg}`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `/app/tests/x.test.ts` becomes `backend/tests/x.test.ts`; anything outside the container app root is rejected. */
function repoPath(name: string, app: App): string {
  if (!name.startsWith(CONTAINER_ROOT))
    fail(`path outside the app root: ${name}`)
  const rest = name.slice(CONTAINER_ROOT.length)
  if (
    rest.includes('\\') ||
    rest.split('/').some((p) => p === '..' || p === '.' || p === '')
  )
    fail(`path outside the app root: ${name}`)
  return `${app}/${rest}`
}

/** Vitest assertion failures print as `AssertionError: …`, including `expect.fail` and `toThrow` misses. */
function isAssertionMessage(message: string): boolean {
  return message.startsWith('AssertionError')
}

export function readVitestJson(json: unknown, app: App): RunSummary {
  if (!isRecord(json) || !Array.isArray(json.testResults))
    fail('missing testResults')
  if (json.testResults.length === 0) fail('empty testResults')
  let reportedFailed = 0
  const summary: RunSummary = {
    files: [],
    total: 0,
    passed: 0,
    failed: 0,
    failures: [],
    tests: [],
    skipped: 0,
    todo: 0,
    passedByFile: {},
    failsMode: [],
  }
  for (const f of json.testResults as unknown[]) {
    if (
      !isRecord(f) ||
      typeof f.name !== 'string' ||
      typeof f.status !== 'string' ||
      !Array.isArray(f.assertionResults)
    )
      fail('malformed file result')
    const file = repoPath(f.name, app)
    if (summary.files.includes(file)) fail(`duplicate file: ${file}`)
    summary.files.push(file)
    summary.passedByFile[file] = 0
    for (const a of f.assertionResults as unknown[]) {
      if (
        !isRecord(a) ||
        typeof a.fullName !== 'string' ||
        typeof a.status !== 'string'
      )
        fail(`malformed test result in ${file}`)
      const messages = Array.isArray(a.failureMessages)
        ? a.failureMessages.filter((m): m is string => typeof m === 'string')
        : []
      summary.total++
      summary.tests.push({ file, name: a.fullName, status: a.status })
      if (a.status === 'passed') {
        summary.passed++
        summary.passedByFile[file]!++
      } else if (a.status === 'failed') {
        summary.failed++
        const message = messages[0] ?? ''
        summary.failures.push({
          file,
          name: a.fullName,
          isAssertion: isAssertionMessage(message),
          message,
        })
        reportedFailed++
      } else if (a.status === 'skipped') summary.skipped++
      else if (a.status === 'todo') summary.todo++
      else {
        // Unknown or non-terminal status (e.g. pending): never treat as clean.
        summary.failed++
        summary.failures.push({
          file,
          name: a.fullName,
          isAssertion: false,
          message: `unexpected test status: ${a.status}`,
        })
      }
    }
    // A file that failed without a single failed test (import error, top-level throw) is a failure too.
    const hasFailedTest = (f.assertionResults as { status?: unknown }[]).some(
      (a) => a.status === 'failed',
    )
    if (f.status === 'failed' && !hasFailedTest) {
      summary.total++
      summary.failed++
      summary.failures.push({
        file,
        name: LOAD_FAILURE_NAME,
        isAssertion: false,
        message: typeof f.message === 'string' ? f.message : '',
      })
    }
  }
  const caseCount = summary.tests.length
  if (
    typeof json.numTotalTests === 'number' &&
    json.numTotalTests !== caseCount
  )
    fail(
      `numTotalTests ${json.numTotalTests} disagrees with ${caseCount} tests`,
    )
  if (
    typeof json.numFailedTests === 'number' &&
    json.numFailedTests !== reportedFailed
  )
    fail(
      `numFailedTests ${json.numFailedTests} disagrees with ${reportedFailed} failed tests`,
    )
  if (json.success === false && summary.failed === 0)
    fail('success is false but no failure was found')
  return summary
}

/** Expected files that were not executed. */
export function discoveryMismatch(
  expected: string[],
  executed: string[],
): string[] {
  const ran = new Set(executed)
  return expected.filter((f) => !ran.has(f))
}
