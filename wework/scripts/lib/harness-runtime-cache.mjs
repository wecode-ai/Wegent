import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resolve archive and materialized Harness Runtime paths for one Wework tree.
 */
export function resolveHarnessRuntimeCachePaths(weworkRoot, environment = process.env) {
  const cacheRoot = environment.WEWORK_HARNESS_RUNTIME_CACHE_ROOT?.trim()
    ? resolve(weworkRoot, environment.WEWORK_HARNESS_RUNTIME_CACHE_ROOT.trim())
    : join(weworkRoot, 'node_modules', '.cache')
  const assetCacheRoot = environment.WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT?.trim()
    ? resolve(weworkRoot, environment.WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT.trim())
    : cacheRoot

  return {
    assetDirectory: join(assetCacheRoot, 'harness-runtime-assets'),
    cacheRoot,
    materializedRoot: join(cacheRoot, 'harness-runtime-dev'),
    prepareLockPath: join(assetCacheRoot, 'harness-runtime-prepare.lock'),
  }
}

/**
 * Resolve the machine-level archive cache used by Electron verification builds.
 */
export function resolveSharedHarnessRuntimeAssetCacheRoot(
  environment = process.env,
  runtime = { platform: process.platform },
  baseDirectory = process.cwd()
) {
  const configuredAssetRoot = environment.WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT?.trim()
  if (configuredAssetRoot) return resolve(baseDirectory, configuredAssetRoot)

  const configuredCacheRoot = environment.WEWORK_HARNESS_RUNTIME_CACHE_ROOT?.trim()
  if (configuredCacheRoot) return resolve(baseDirectory, configuredCacheRoot)

  if (runtime.platform === 'darwin') {
    return join(environment.HOME || tmpdir(), 'Library', 'Caches', 'wegent', 'harness-runtime')
  }
  if (runtime.platform === 'win32') {
    return join(
      environment.LOCALAPPDATA || environment.USERPROFILE || tmpdir(),
      'wegent',
      'harness-runtime'
    )
  }
  return join(
    environment.XDG_CACHE_HOME || join(environment.HOME || tmpdir(), '.cache'),
    'wegent',
    'harness-runtime'
  )
}

/**
 * Preserve process settings while isolating mutable runtimes to the current worktree.
 */
export function resolveHarnessRuntimeAssetCacheEnvironment(
  environment = process.env,
  runtime = { platform: process.platform },
  baseDirectory = process.cwd()
) {
  const { WEWORK_HARNESS_RUNTIME_CACHE_ROOT: _cacheRoot, ...isolatedEnvironment } = environment

  return {
    ...isolatedEnvironment,
    WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT: resolveSharedHarnessRuntimeAssetCacheRoot(
      environment,
      runtime,
      baseDirectory
    ),
  }
}
