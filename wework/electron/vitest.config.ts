import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Leave CPU capacity for subprocesses and parallel pre-push checks.
    maxWorkers: 2,
    ...(process.env.WEWORK_TEST_REPORT_FILE
      ? {
          reporters: [
            'default',
            ...(process.env.GITHUB_ACTIONS === 'true' ? (['github-actions'] as const) : []),
            [
              'junit',
              { outputFile: process.env.WEWORK_TEST_REPORT_FILE, includeConsoleOutput: false },
            ],
          ],
        }
      : {}),
  },
})
