import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { isWegentCloudMarketplace } from '@/features/plugins/pluginNavigation'
import type { InstalledPluginItem } from './PluginManagementRows'
import { installedPluginMarketplaceId, marketplaceItemMarketplaceId } from './pluginDistribution'

function normalizedMarketplaceId(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim().toLowerCase()
  if (!trimmed) return ''
  return isWegentCloudMarketplace(trimmed) ? 'wegent' : trimmed
}

function installedPluginKey(plugin: InstalledPlugin): string {
  return String(plugin.spec.source.pluginKey || plugin.metadata.name || '')
    .trim()
    .toLowerCase()
}

/**
 * Resolve the marketplace catalog row for an installed plugin so UI can reuse
 * package logos / detail already resolved for the market list.
 *
 * Match order: installedPluginId → cloud pluginId → pluginKey@marketplace.
 */
export function findMarketplaceItemForInstalledPlugin(
  plugin: InstalledPlugin,
  items: PluginMarketplaceItem[],
  installedId?: string | number | null
): PluginMarketplaceItem | null {
  if (items.length === 0) return null

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

  const cloudPluginId = plugin.spec.pluginId
  if (typeof cloudPluginId === 'number') {
    const byPluginId = items.find(item => String(item.id) === String(cloudPluginId))
    if (byPluginId) return byPluginId
  }

  const key = installedPluginKey(plugin)
  const marketplace = normalizedMarketplaceId(installedPluginMarketplaceId(plugin))
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

export function findMarketplaceItemForInstalled(
  plugin: InstalledPluginItem,
  items: PluginMarketplaceItem[]
): PluginMarketplaceItem | null {
  return findMarketplaceItemForInstalledPlugin(plugin.raw, items, plugin.id)
}
