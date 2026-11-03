import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    reporters: process.env.WEWORK_TEST_REPORT_FILE
      ? [
          'default',
          [
            'junit',
            { outputFile: process.env.WEWORK_TEST_REPORT_FILE, includeConsoleOutput: false },
          ],
        ]
      : ['default'],
  },
})
