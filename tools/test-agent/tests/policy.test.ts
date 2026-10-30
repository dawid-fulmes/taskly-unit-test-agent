import { describe, expect, it } from 'vitest'
import {
  appOf,
  isConfigPath,
  isEvidencePath,
  isSecretPath,
  isSourcePath,
  isTestPath,
  loadPolicy,
} from '../src/policy.ts'

describe('policy', () => {
  it('classifies paths', () => {
    const p = loadPolicy()
    expect(isTestPath(p, 'backend/tests/router.test.ts')).toBe(true)
    expect(isTestPath(p, 'frontend/src/a/B.test.tsx')).toBe(true)
    expect(isTestPath(p, 'backend/tests/fixture.ts')).toBe(false)
    expect(isTestPath(p, 'frontend/src/test/setup.ts')).toBe(false)
    expect(isTestPath(p, 'backend/tests/__evidence__/x.test.ts')).toBe(false)
    expect(isEvidencePath(p, 'backend/tests/__evidence__/x.test.ts')).toBe(true)
    expect(isEvidencePath(p, 'frontend/src/a/__evidence__/x.test.tsx')).toBe(
      true,
    )
    expect(isEvidencePath(p, 'backend/tests/router.test.ts')).toBe(false)
    expect(isSourcePath(p, 'frontend/src/a/B.stories.tsx')).toBe(false)
    expect(isSourcePath(p, 'frontend/src/a/B.test.tsx')).toBe(false)
    expect(isSourcePath(p, 'backend/src/features/todos/router.ts')).toBe(true)
    expect(isConfigPath(p, 'frontend/tsconfig.json')).toBe(true)
    expect(isConfigPath(p, 'backend/vitest.config.ts')).toBe(true)
    expect(isConfigPath(p, 'backend/src/x.ts')).toBe(false)
    expect(isSecretPath(p, '.env')).toBe(true)
    expect(isSecretPath(p, 'backend/.env.local')).toBe(true)
    expect(isSecretPath(p, '.env.example')).toBe(false)
    expect(appOf('backend/src/x.ts')).toBe('backend')
    expect(appOf('frontend/src/x.ts')).toBe('frontend')
    expect(appOf('README.md')).toBeNull()
  })

  it('exposes policy values', () => {
    const p = loadPolicy()
    expect(p.skipMinChangedLineCoverage).toBe(0.8)
    expect(p.forbiddenTestCalls).toContain('.skip(')
    expect(p.forbiddenAssertions).toContain('toMatchSnapshot(')
  })
})
