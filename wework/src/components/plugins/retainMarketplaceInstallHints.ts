import type { PluginMarketplaceItem } from '@/types/api'

/**
 * Progressive catalog paints can briefly reuse a stale cache snapshot after a
 * successful install. Keep the optimistic installed row until Codex/cloud catch up.
 */
export function retainMarketplaceInstallHints(
  previousItems: PluginMarketplaceItem[],
  nextItems: PluginMarketplaceItem[]
): PluginMarketplaceItem[] {
  if (previousItems.length === 0 || nextItems.length === 0) return nextItems

  const previousById = new Map(previousItems.map(item => [String(item.id), item]))
  return nextItems.map(item => {
    if (item.installed && item.installedPluginId != null) return item
    const previous = previousById.get(String(item.id))
    if (!previous?.installed || previous.installedPluginId == null) return item
    return {
      ...item,
      installed: true,
      installedLocally: previous.installedLocally ?? true,
      installedPluginId: previous.installedPluginId,
      enabled: previous.enabled,
      currentDeviceInstallation:
        item.currentDeviceInstallation ?? previous.currentDeviceInstallation ?? null,
      components: item.components ?? previous.components,
      manifest: {
        ...previous.manifest,
        ...item.manifest,
        marketplaceId:
          (typeof item.manifest?.marketplaceId === 'string' && item.manifest.marketplaceId) ||
          (typeof previous.manifest?.marketplaceId === 'string'
            ? previous.manifest.marketplaceId
            : null),
      },
    }
  })
}
