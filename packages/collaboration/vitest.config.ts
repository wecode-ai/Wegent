import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/test/setup.ts'],
    // Limit concurrent jsdom workers so full-suite runs stay below the contention point.
    maxWorkers: 2,
  },
})
