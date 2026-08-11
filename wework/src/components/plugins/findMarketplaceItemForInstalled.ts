import type { PluginMarketplaceItem } from '@/types/api'
import { isWegentCloudMarketplace } from '@/features/plugins/pluginNavigation'
import type { InstalledPluginItem } from './PluginManagementRows'
import { installedPluginMarketplaceId, marketplaceItemMarketplaceId } from './pluginDistribution'

function normalizedMarketplaceId(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim().toLowerCase()
  if (!trimmed) return ''
  return isWegentCloudMarketplace(trimmed) ? 'wegent' : trimmed
}

function pluginKey(plugin: InstalledPluginItem): string {
  return String(plugin.raw.spec.source.pluginKey || plugin.raw.metadata.name || '')
    .trim()
    .toLowerCase()
}

/**
 * Resolve the marketplace catalog row for an installed plugin so the installed
 * strip can open the same enriched detail path as the market list.
 *
 * Match order: installedPluginId → cloud pluginId → pluginKey@marketplace.
 */
export function findMarketplaceItemForInstalled(
  plugin: InstalledPluginItem,
  items: PluginMarketplaceItem[]
): PluginMarketplaceItem | null {
  if (items.length === 0) return null

  const installedId = String(plugin.id)
  const byInstalledPluginId = items.find(
    item =>
      item.installedPluginId !== null &&
      item.installedPluginId !== undefined &&
      String(item.installedPluginId) === installedId
  )
  if (byInstalledPluginId) return byInstalledPluginId

  const cloudPluginId = plugin.raw.spec.pluginId
  if (typeof cloudPluginId === 'number') {
    const byPluginId = items.find(item => String(item.id) === String(cloudPluginId))
    if (byPluginId) return byPluginId
  }

  const key = pluginKey(plugin)
  const marketplace = normalizedMarketplaceId(installedPluginMarketplaceId(plugin.raw))
  if (!key || !marketplace) return null

  return (
    items.find(item => {
      const itemKey = item.name.trim().toLowerCase()
      if (itemKey !== key) return false
      const itemMarketplace =
        normalizedMarketplaceId(marketplaceItemMarketplaceId(item)) ||
        (item.latestReleaseId != null ? 'wegent' : '')
      return itemMarketplace === marketplace
    }) ?? null
  )
}
