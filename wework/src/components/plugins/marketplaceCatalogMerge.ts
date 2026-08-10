import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { isBuiltInMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { marketplaceItemMarketplaceId } from './pluginDistribution'
import { linkedCloudPluginId, localPluginId } from './installedPluginMerge'

export function isLocalMarketplaceItem(item: PluginMarketplaceItem): boolean {
  if (item.latestReleaseId != null) return false
  return marketplaceItemMarketplaceId(item) !== null
}

export function shouldShowInstalledMarketplaceActions(
  item: PluginMarketplaceItem,
  isLoggedIn: boolean
): boolean {
  return item.installed && (isLoggedIn || item.installedLocally || isLocalMarketplaceItem(item))
}

export function mergeMarketplaceCatalog(
  cloudItems: PluginMarketplaceItem[],
  localItems: PluginMarketplaceItem[],
  installedPlugins: InstalledPlugin[]
): PluginMarketplaceItem[] {
  const localPublishedInstalls = new Map<string, InstalledPlugin>()
  for (const plugin of installedPlugins) {
    const cloudPluginId = linkedCloudPluginId(plugin)
    if (cloudPluginId !== null && localPluginId(plugin) !== null) {
      localPublishedInstalls.set(String(cloudPluginId), plugin)
    }
  }

  const merged = new Map<string, PluginMarketplaceItem>()
  const cloudNames = new Set<string>()
  for (const item of cloudItems) {
    const localInstall = localPublishedInstalls.get(String(item.id))
    // Cloud catalog ids are unique; never collapse distinct plugins by display name.
    merged.set(`cloud:${item.id}`, {
      ...item,
      ...(localInstall
        ? {
            installed: true,
            installedPluginId: localPluginId(localInstall),
            installedLocally: true,
            enabled: localInstall.spec.enabled,
            updateAvailable: false,
            currentDeviceInstallation: null,
          }
        : {}),
    })
    cloudNames.add(item.name.toLowerCase())
  }
  for (const item of localItems) {
    const marketplaceId = marketplaceItemMarketplaceId(item)
    if (marketplaceId && !isBuiltInMarketplaceId(marketplaceId)) {
      const key = `local:${marketplaceId.toLowerCase()}:${item.name.toLowerCase()}`
      if (!merged.has(key)) merged.set(key, item)
      continue
    }
    // Built-in local mirrors of a cloud listing are already represented above.
    if (cloudNames.has(item.name.toLowerCase())) continue
    const key = `local-builtin:${(marketplaceId || 'unknown').toLowerCase()}:${item.name.toLowerCase()}`
    if (!merged.has(key)) merged.set(key, item)
  }
  return Array.from(merged.values())
}
