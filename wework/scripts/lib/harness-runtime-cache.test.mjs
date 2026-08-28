import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { resolveHarnessRuntimeCachePaths } from './harness-runtime-cache.mjs'

const scriptsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const weworkRoot = path.resolve(scriptsRoot, '..')

describe('Harness Runtime cache paths', () => {
  test('uses the workspace cache by default', () => {
    const paths = resolveHarnessRuntimeCachePaths('/workspace/wework', {})

    expect(paths).toEqual({
      cacheRoot: path.join('/workspace/wework', 'node_modules', '.cache'),
      assetDirectory: path.join(
        '/workspace/wework',
        'node_modules',
        '.cache',
        'harness-runtime-assets'
      ),
      materializedRoot: path.join(
        '/workspace/wework',
        'node_modules',
        '.cache',
        'harness-runtime-dev'
      ),
      prepareLockPath: path.join(
        '/workspace/wework',
        'node_modules',
        '.cache',
        'harness-runtime-prepare.lock'
      ),
    })
  })

  test('uses the configured persistent cache for every Harness Runtime path', () => {
    const paths = resolveHarnessRuntimeCachePaths('/workspace/wework', {
      WEWORK_HARNESS_RUNTIME_CACHE_ROOT: '  /cache/harness-runtime  ',
    })

    expect(paths).toEqual({
      cacheRoot: '/cache/harness-runtime',
      assetDirectory: path.join('/cache/harness-runtime', 'harness-runtime-assets'),
      materializedRoot: path.join('/cache/harness-runtime', 'harness-runtime-dev'),
      prepareLockPath: path.join('/cache/harness-runtime', 'harness-runtime-prepare.lock'),
    })
  })

  test('shares the cache resolver between asset preparation and packaging', async () => {
    const [prepareSource, packageSource] = await Promise.all([
      readFile(path.join(scriptsRoot, 'prepare-harness-runtime.mjs'), 'utf8'),
      readFile(path.join(weworkRoot, 'electron/scripts/prepare-package-assets.mjs'), 'utf8'),
    ])

    expect(prepareSource).toContain('resolveHarnessRuntimeCachePaths(root)')
    expect(packageSource).toContain('resolveHarnessRuntimeCachePaths(weworkRoot)')
    expect(packageSource).not.toContain(
      "join(weworkRoot, 'node_modules', '.cache', 'harness-runtime-assets'"
    )
  })
})
