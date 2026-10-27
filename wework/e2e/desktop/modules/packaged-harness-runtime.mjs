import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export async function preparePackagedHarnessRuntimeRoots({
  appBinary,
  configuredRuntimeRoot,
  extractArchive,
  platform = process.platform,
  resultDirectory,
}) {
  const resourcesRoot = join(
    dirname(appBinary),
    ...(platform === 'darwin' ? ['..', 'Resources'] : ['resources'])
  )
  const packagedResources = join(resourcesRoot, 'harness-runtime')
  const catalog = JSON.parse(await readFile(join(packagedResources, 'runtimes.json'), 'utf8'))
  const runtimeRoot = configuredRuntimeRoot
    ? resolve(configuredRuntimeRoot)
    : join(resultDirectory, 'harness-runtime')
  if (!configuredRuntimeRoot) {
    await rm(runtimeRoot, { recursive: true, force: true })
    await mkdir(runtimeRoot, { recursive: true })
    const runtimes = new Map(catalog.runtimes.map(runtime => [runtime.sourceFingerprint, runtime]))
    for (const runtime of runtimes.values()) {
      const extracted = join(runtimeRoot, runtime.sourceFingerprint)
      await mkdir(extracted, { recursive: true })
      await extractArchive(join(packagedResources, runtime.assetName), extracted)
    }
  }
  for (const runtime of catalog.runtimes) {
    const extracted = join(runtimeRoot, runtime.sourceFingerprint)
    const identity = JSON.parse(await readFile(join(extracted, 'runtime.json'), 'utf8'))
    if (
      identity.dshVersion !== runtime.dshVersion ||
      identity.sourceFingerprint !== runtime.sourceFingerprint ||
      !(
        identity.role === runtime.role ||
        (Array.isArray(identity.roles) && identity.roles.includes(runtime.role))
      )
    ) {
      throw new Error(`Bundled DSH runtime identity mismatch: ${runtime.assetName}`)
    }
    await readFile(join(extracted, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  return {
    corePluginsRoot: join(resourcesRoot, 'wework-core-plugins'),
    harnessRuntimeRoot: runtimeRoot,
  }
}
