import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Regression guards for trust-boundary properties of the workflow files that unit tests of the
// CLIs cannot see. They read the YAML as text on purpose: no YAML dependency, no interpretation.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
)
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8')
const prepare = read('.github/actions/prepare/action.yml')
const pipeline = read('.github/workflows/test-agent-pipeline.yml')

describe('work dependencies are never installed on the runner host', () => {
  // npm reads the PR's own .npmrc (e.g. `git=./script`) even with --ignore-scripts, so the work
  // install must run in the throwaway container, never on the host where secrets appear later.
  it('installs work dependencies inside the pinned container with an empty environment', () => {
    const step = prepare.slice(prepare.indexOf('Install work dependencies'))
    const body = step.slice(0, step.indexOf('- name:', 1))
    expect(body).toContain('docker run --rm')
    expect(body).toContain('--env-file /dev/null')
    expect(body).toContain('npm ci --ignore-scripts')
    expect(body).not.toMatch(/\(cd "\$WORK\/\$app" && npm ci/)
  })

  it('every prepare call that installs a work tree also provides the image', () => {
    const calls = pipeline
      .split('uses: ./trusted/.github/actions/prepare')
      .slice(1)
    for (const call of calls) {
      const withBlock = call.slice(
        0,
        call.indexOf('- uses:') === -1 ? undefined : call.indexOf('- uses:'),
      )
      if (/\n\s+work: /.test(withBlock))
        expect(withBlock).toMatch(/\n\s+image: /)
    }
  })
})

describe('publish', () => {
  const job = pipeline.slice(pipeline.indexOf('\n  publish:'))

  it('posts nothing when an upstream job was cancelled by a newer run', () => {
    const cond = /\n    if: (.*)\n/.exec(job)?.[1] ?? ''
    expect(cond).toContain('!cancelled()')
    for (const need of ['plan', 'generate', 'verify'])
      expect(cond).toContain(`needs.${need}.result != 'cancelled'`)
  })

  it('needs no reviewer approval (the backfill approval gates only the model key)', () => {
    expect(job).toMatch(/\n    environment: test-agent-pr\n/)
  })
})
