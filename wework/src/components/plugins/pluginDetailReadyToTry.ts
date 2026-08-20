import type { PluginMarketplaceItem } from '@/types/api'
import { hasLocalCodexMaterialization, storeDirMatchesPluginKey } from './installedPluginMerge'
import type { InstalledPluginItem } from './PluginManagementRows'

function installedBelongsToMarketplaceItem(
  plugin: InstalledPluginItem,
  item: PluginMarketplaceItem
): boolean {
  if (
    item.installedPluginId !== null &&
    item.installedPluginId !== undefined &&
    String(plugin.id) === String(item.installedPluginId)
  ) {
    return true
  }
  if (
    typeof plugin.raw.spec.pluginId === 'number' &&
    String(plugin.raw.spec.pluginId) === String(item.id)
  ) {
    return true
  }
  return (
    storeDirMatchesPluginKey(String(plugin.id), item.name) ||
    storeDirMatchesPluginKey(String(plugin.raw.metadata.name || ''), item.name) ||
    storeDirMatchesPluginKey(String(plugin.raw.spec.source.pluginKey || ''), item.name)
  )
}

/**
 * This device can run the plugin (chat / skills). Account installState and
 * other-device pending/failed rows are not enough; local ZIP/Codex presence is.
 */
export function pluginDetailReadyToTry(
  plugin: InstalledPluginItem,
  marketplaceItem?: PluginMarketplaceItem | null
): boolean {
  if (
    hasLocalCodexMaterialization(plugin.raw) &&
    (!marketplaceItem || installedBelongsToMarketplaceItem(plugin, marketplaceItem))
  ) {
    return true
  }
  if (marketplaceItem?.installedLocally) return true
  return marketplaceItem?.currentDeviceInstallation?.state === 'installed'
}
