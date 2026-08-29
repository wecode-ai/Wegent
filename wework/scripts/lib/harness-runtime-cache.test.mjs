import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import {
  resolveHarnessRuntimeAssetCacheEnvironment,
  resolveHarnessRuntimeCachePaths,
  resolveSharedHarnessRuntimeAssetCacheRoot,
} from './harness-runtime-cache.mjs'

describe('resolveHarnessRuntimeCachePaths', () => {
  test('keeps materialized runtimes in the worktree by default', () => {
    expect(resolveHarnessRuntimeCachePaths('/workspace/wework', {})).toEqual({
      assetDirectory: join('/workspace/wework', 'node_modules', '.cache', 'harness-runtime-assets'),
      cacheRoot: join('/workspace/wework', 'node_modules', '.cache'),
      materializedRoot: join('/workspace/wework', 'node_modules', '.cache', 'harness-runtime-dev'),
      prepareLockPath: join(
        '/workspace/wework',
        'node_modules',
        '.cache',
        'harness-runtime-prepare.lock'
      ),
    })
  })

  test('uses the configured asset cache for archives and its lock only', () => {
    expect(
      resolveHarnessRuntimeCachePaths('/workspace/wework', {
        WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT: '/shared/harness',
      })
    ).toEqual({
      assetDirectory: join('/shared/harness', 'harness-runtime-assets'),
      cacheRoot: join('/workspace/wework', 'node_modules', '.cache'),
      materializedRoot: join('/workspace/wework', 'node_modules', '.cache', 'harness-runtime-dev'),
      prepareLockPath: join('/shared/harness', 'harness-runtime-prepare.lock'),
    })
  })

  test('resolves relative overrides from the Wework root', () => {
    expect(
      resolveHarnessRuntimeCachePaths('/workspace/wework', {
        WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT: '../shared/harness',
      }).assetDirectory
    ).toBe(join('/workspace/shared/harness', 'harness-runtime-assets'))
  })
})

describe('resolveHarnessRuntimeAssetCacheEnvironment', () => {
  test('translates the general cache override into an archive-only override', () => {
    const environment = resolveHarnessRuntimeAssetCacheEnvironment(
      {
        CUSTOM_SETTING: 'preserved',
        WEWORK_HARNESS_RUNTIME_CACHE_ROOT: '../shared/harness',
      },
      { platform: 'linux' },
      '/workspace/wework'
    )

    expect(environment).toEqual({
      CUSTOM_SETTING: 'preserved',
      WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT: '/workspace/shared/harness',
    })
    expect(resolveHarnessRuntimeCachePaths('/workspace/wework', environment)).toMatchObject({
      assetDirectory: join('/workspace/shared/harness', 'harness-runtime-assets'),
      materializedRoot: join('/workspace/wework', 'node_modules', '.cache', 'harness-runtime-dev'),
    })
  })
})

describe('resolveSharedHarnessRuntimeAssetCacheRoot', () => {
  test('uses a machine-level macOS cache by default', () => {
    expect(
      resolveSharedHarnessRuntimeAssetCacheRoot({ HOME: '/Users/test' }, { platform: 'darwin' })
    ).toBe(join('/Users/test', 'Library', 'Caches', 'wegent', 'harness-runtime'))
  })

  test('preserves explicit asset and general cache overrides', () => {
    expect(
      resolveSharedHarnessRuntimeAssetCacheRoot(
        {
          WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT: '/asset-cache',
          WEWORK_HARNESS_RUNTIME_CACHE_ROOT: '/general-cache',
        },
        { platform: 'linux' }
      )
    ).toBe('/asset-cache')
    expect(
      resolveSharedHarnessRuntimeAssetCacheRoot(
        { WEWORK_HARNESS_RUNTIME_CACHE_ROOT: '/general-cache' },
        { platform: 'linux' }
      )
    ).toBe('/general-cache')
  })

  test('resolves relative overrides from the caller-provided base directory', () => {
    expect(
      resolveSharedHarnessRuntimeAssetCacheRoot(
        { WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT: '../shared/harness' },
        { platform: 'linux' },
        '/workspace/wework'
      )
    ).toBe('/workspace/shared/harness')
  })

  test.each([
    ['linux', { HOME: '/home/test' }, join('/home/test', '.cache', 'wegent', 'harness-runtime')],
    [
      'linux',
      { HOME: '/home/test', XDG_CACHE_HOME: '/xdg-cache' },
      join('/xdg-cache', 'wegent', 'harness-runtime'),
    ],
    [
      'win32',
      { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
      join('C:\\Users\\test\\AppData\\Local', 'wegent', 'harness-runtime'),
    ],
  ])('uses the platform cache root on %s', (platform, environment, expected) => {
    expect(resolveSharedHarnessRuntimeAssetCacheRoot(environment, { platform })).toBe(expected)
  })
})
