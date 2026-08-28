import path from 'node:path'

export function resolveHarnessRuntimeCachePaths(weworkRoot, environment = process.env) {
  const configuredRoot = environment.WEWORK_HARNESS_RUNTIME_CACHE_ROOT?.trim()
  const cacheRoot = configuredRoot || path.join(weworkRoot, 'node_modules', '.cache')

  return {
    cacheRoot,
    assetDirectory: path.join(cacheRoot, 'harness-runtime-assets'),
    materializedRoot: path.join(cacheRoot, 'harness-runtime-dev'),
    prepareLockPath: path.join(cacheRoot, 'harness-runtime-prepare.lock'),
  }
}
