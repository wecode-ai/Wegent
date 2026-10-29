import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Leave CPU capacity for subprocesses and parallel pre-push checks.
    maxWorkers: 2,
  },
})
