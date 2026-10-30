import { readFileSync } from 'node:fs'
import { Ajv } from 'ajv'

export type SkipTarget =
  { file: string; testName: string } | { reason: 'excluded-from-coverage' }

export interface Report {
  files: {
    path: string
    action: 'create' | 'update' | 'skip' | 'gave-up'
    testFile?: string
    skip?: SkipTarget
  }[]
  behaviours: {
    file: string
    description: string
    source: {
      kind:
        'pr-description' | 'openapi' | 'type' | 'validator' | 'characterization'
      ref: string
    }
  }[]
  defects: {
    file: string
    evidenceTest: string
    summary: string
    citation:
      | { kind: 'openapi'; pointer: string }
      | { kind: 'pr-description'; quote: string }
  }[]
  narrative: string
}

// Loaded from the package directory, never from the (untrusted) work dir.
const schema = JSON.parse(
  readFileSync(
    new URL('../schema/report.schema.json', import.meta.url),
    'utf8',
  ),
) as object
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema)

export function validateReport(
  data: unknown,
): { ok: true; report: Report } | { ok: false; errors: string[] } {
  if (validate(data)) return { ok: true, report: data as Report }
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
  )
  return { ok: false, errors: errors.length ? errors : ['invalid report'] }
}
