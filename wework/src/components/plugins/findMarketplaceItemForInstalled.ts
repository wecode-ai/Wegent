import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import { linkedCloudPluginId, storeDirMatchesPluginKey } from './installedPluginMerge'
import {
  installedPluginMarketplaceId,
  marketplaceItemMarketplaceId,
  normalizedMarketplaceId,
} from './pluginDistribution'

function installedPluginKey(plugin: InstalledPlugin): string {
  return String(plugin.spec.source.pluginKey || plugin.metadata.name || '')
    .trim()
    .toLowerCase()
}

/**
 * Resolve the marketplace catalog row for an installed plugin so UI can reuse
 * package logos / detail already resolved for the market list.
 *
 * A known cloud plugin ID is authoritative; local-only rows use install ID,
 * then pluginKey@marketplace. Missing cloud identities never fall back to names.
 */
export function findMarketplaceItemForInstalledPlugin(
  plugin: InstalledPlugin,
  items: PluginMarketplaceItem[],
  installedId?: string | number | null
): PluginMarketplaceItem | null {
  if (items.length === 0) return null

  const cloudPluginId = plugin.spec.pluginId ?? linkedCloudPluginId(plugin)
  if (typeof cloudPluginId === 'number') {
    return items.find(item => String(item.id) === String(cloudPluginId)) ?? null
  }

  if (installedId !== null && installedId !== undefined && String(installedId).trim()) {
    const id = String(installedId)
    const byInstalledPluginId = items.find(
      item =>
        item.installedPluginId !== null &&
        item.installedPluginId !== undefined &&
        String(item.installedPluginId) === id
    )
    if (byInstalledPluginId) return byInstalledPluginId
  }

  const key = installedPluginKey(plugin)
  const marketplace = normalizedMarketplaceId(installedPluginMarketplaceId(plugin))
  const matchesMarketplace = (item: PluginMarketplaceItem) => {
    const itemMarketplace =
      normalizedMarketplaceId(marketplaceItemMarketplaceId(item)) ||
      (item.latestReleaseId != null ? 'wegent' : '')
    return !marketplace || itemMarketplace === marketplace
  }
  if (key && marketplace) {
    const byIdentity = items.find(item => {
      const itemKey = item.name.trim().toLowerCase()
      if (itemKey !== key) return false
      return matchesMarketplace(item)
    })
    if (byIdentity) return byIdentity
  }

  const storeDirCandidates = items.filter(item => {
    if (!matchesMarketplace(item)) return false
    return (
      storeDirMatchesPluginKey(String(installedId ?? ''), item.name) ||
      storeDirMatchesPluginKey(String(plugin.metadata.name || ''), item.name) ||
      storeDirMatchesPluginKey(key, item.name)
    )
  })
  storeDirCandidates.sort((left, right) => right.name.length - left.name.length)
  return storeDirCandidates[0] ?? null
}

export function findMarketplaceItemForInstalled(
  plugin: InstalledPluginItem,
  items: PluginMarketplaceItem[]
): PluginMarketplaceItem | null {
  return findMarketplaceItemForInstalledPlugin(plugin.raw, items, plugin.id)
}
