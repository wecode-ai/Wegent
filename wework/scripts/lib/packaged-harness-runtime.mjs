export function packagedHarnessRuntimeCatalog(catalog) {
  const runtimes = catalog.runtimes.filter(runtime => ['core', 'workbench'].includes(runtime.role))
  const coreVersions = new Set(
    runtimes.filter(runtime => runtime.role === 'core').map(runtime => runtime.dshVersion)
  )
  if (coreVersions.size !== 1) throw new Error('Exactly one default Core DSH version is required')
  const [defaultVersion] = coreVersions
  const bundled = runtimes.filter(runtime => runtime.dshVersion === defaultVersion)
  if (!bundled.some(runtime => runtime.role === 'workbench')) {
    throw new Error('Default DSH version must support Workbench')
  }
  return {
    runtimes: bundled,
    downloadableRuntimes: runtimes.filter(runtime => runtime.dshVersion !== defaultVersion),
  }
}
