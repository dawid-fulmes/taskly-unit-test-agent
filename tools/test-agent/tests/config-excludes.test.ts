import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readCoverageExcludes } from '../src/config-excludes.ts'

const root = new URL('../../../', import.meta.url)

describe('readCoverageExcludes', () => {
  it('reads the frontend vite config', () => {
    const src = readFileSync(new URL('frontend/vite.config.ts', root), 'utf8')
    expect(readCoverageExcludes(src)).toContain('src/design-system/**')
  })
  it('reads the backend vitest config', () => {
    const src = readFileSync(new URL('backend/vitest.config.ts', root), 'utf8')
    expect(readCoverageExcludes(src)).toContain('src/generated/**')
  })
  it('throws when exclude is a variable', () => {
    const src = `const ex = ['a']\nexport default { test: { coverage: { exclude: ex } } }`
    expect(() => readCoverageExcludes(src)).toThrow()
  })
  it('throws when an element is not a string literal', () => {
    const src = `export default { test: { coverage: { exclude: ['a', x] } } }`
    expect(() => readCoverageExcludes(src)).toThrow()
  })
  it('throws when there is no coverage.exclude', () => {
    expect(() => readCoverageExcludes(`export default {}`)).toThrow()
  })
})
