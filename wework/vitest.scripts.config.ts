import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

import { discoverNodeTestFiles } from './scripts/lib/test-files.mjs'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.mjs'],
    exclude: [
      ...configDefaults.exclude,
      ...discoverNodeTestFiles(fileURLToPath(new URL('.', import.meta.url)), ['scripts']),
    ],
    maxWorkers: 2,
  },
})
