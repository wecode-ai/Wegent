import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import type { BuiltinReporterOptions } from 'vitest/reporters'
import viteConfig from './vite.config'
import { discoverNodeTestFiles } from './scripts/lib/test-files.mjs'

const nodeTestScripts = discoverNodeTestFiles(__dirname, ['scripts'])

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      sequence:
        process.env.WEWORK_CI_BALANCED_SHARDS === 'true'
          ? { sequencer: (await import('./scripts/ci-test-sequencer.mjs')).default }
          : undefined,
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      globals: true,
      ...(process.env.WEWORK_TEST_REPORT_FILE || process.env.WEWORK_TEST_TIMING_FILE
        ? {
            reporters: [
              'default',
              ...(process.env.GITHUB_ACTIONS === 'true' ? (['github-actions'] as const) : []),
              ...(process.env.WEWORK_TEST_REPORT_FILE
                ? [
                    [
                      'junit',
                      {
                        outputFile: process.env.WEWORK_TEST_REPORT_FILE,
                        includeConsoleOutput: false,
                      },
                    ] satisfies ['junit', Partial<BuiltinReporterOptions['junit']>],
                  ]
                : []),
              ...(process.env.WEWORK_TEST_TIMING_FILE
                ? [
                    ['json', { outputFile: process.env.WEWORK_TEST_TIMING_FILE }] satisfies [
                      'json',
                      Partial<BuiltinReporterOptions['json']>,
                    ],
                  ]
                : []),
            ],
          }
        : {}),
      server: {
        deps: {
          inline: [/@file-viewer/, /@panzoom/, /mermaid/],
        },
      },
      // Keep local and pre-push runs below the resource-contention point where
      // jsdom-heavy files begin timing out nondeterministically.
      maxWorkers: 2,
      exclude: [
        ...configDefaults.exclude,
        ...nodeTestScripts,
        'dsh/**/*.test.mjs',
        'e2e/**',
        'electron/**',
        'scripts/electron-e2e-launch-arguments.test.mjs',
        'scripts/harness-runtime-metadata.test.mjs',
        'test-results/**',
      ],
      coverage: {
        provider: 'istanbul',
        reporter: ['text', 'json', 'lcov'],
        reportsDirectory: './coverage',
      },
    },
  })
)
