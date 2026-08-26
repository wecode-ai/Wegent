import type { InstalledPlugin, LocalDeviceApp, RuntimeProjectPluginRef } from '@/types/api'

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function installedPluginProjectRef(plugin: InstalledPlugin): RuntimeProjectPluginRef | null {
  if (!['installed', 'update_available'].includes(plugin.spec.installState)) return null

  const pluginName = plugin.spec.source.pluginKey.trim()
  const manifestMarketplaceId =
    typeof plugin.spec.manifest.marketplaceId === 'string'
      ? plugin.spec.manifest.marketplaceId.trim()
      : ''
  const marketplaceId =
    plugin.spec.source.marketplace?.trim() ||
    manifestMarketplaceId ||
    plugin.spec.source.providerKey.trim()
  if (!pluginName || !marketplaceId) return null

  return {
    id: `${pluginName}@${marketplaceId}`,
    pluginName,
    marketplaceId,
    displayName: plugin.spec.displayName.trim() || pluginName,
  }
}

export function mergeProjectPluginCatalogs(
  ...catalogs: RuntimeProjectPluginRef[][]
): RuntimeProjectPluginRef[] {
  const merged = new Map<string, RuntimeProjectPluginRef>()
  catalogs.flat().forEach(plugin => {
    const key = `${normalized(plugin.pluginName)}@${normalized(plugin.marketplaceId)}`
    if (!key || key === '@') return
    const current = merged.get(key)
    merged.set(key, {
      ...(current ?? plugin),
      ...plugin,
      displayName:
        current && current.displayName !== current.pluginName
          ? current.displayName
          : plugin.displayName,
    })
  })
  return Array.from(merged.values()).sort((left, right) =>
    left.displayName.localeCompare(right.displayName)
  )
}

export function buildProjectPluginCatalog(
  installedPlugins: InstalledPlugin[],
  codexApps: LocalDeviceApp[] = []
): RuntimeProjectPluginRef[] {
  const appNames = new Map<string, string>()
  codexApps.forEach(app => {
    const aliases = [app.pluginKey, app.id, ...(app.pluginDisplayNames ?? [])]
    aliases.forEach(alias => {
      const key = normalized(alias)
      if (key) appNames.set(key, app.name.trim() || alias || '')
    })
  })

  return mergeProjectPluginCatalogs(
    installedPlugins.flatMap(plugin => {
      const ref = installedPluginProjectRef(plugin)
      if (!ref) return []
      const appName =
        appNames.get(normalized(ref.pluginName)) || appNames.get(normalized(ref.displayName))
      return [{ ...ref, displayName: appName || ref.displayName }]
    })
  )
}
