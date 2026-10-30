import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Slow (~70s): installs deps in Docker. Run with `npm run test:docker`.
    exclude: ['tests/**/*.docker.test.ts', 'node_modules/**'],
  },
})
