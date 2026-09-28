import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Limit concurrent jsdom workers so full-suite runs stay below the contention point.
    maxWorkers: 2,
  },
})
