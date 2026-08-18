import type { PluginMarketplaceItem } from '@/types/api'
import { isOpenAiOfficialRemoteMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { installedPluginMarketplaceId, marketplaceItemMarketplaceId } from './pluginDistribution'
import type { InstalledPluginItem } from './PluginManagementRows'

/**
 * Progressive catalog paints can briefly reuse a stale cache snapshot after a
 * successful install. Keep the optimistic installed row until Codex/cloud catch up.
 */
export function retainMarketplaceInstallHints(
  previousItems: PluginMarketplaceItem[],
  nextItems: PluginMarketplaceItem[],
  options?: { skipMarketplaceIds?: ReadonlySet<string> }
): PluginMarketplaceItem[] {
  if (previousItems.length === 0 || nextItems.length === 0) return nextItems

  const previousById = new Map(previousItems.map(item => [String(item.id), item]))
  const skipMarketplaceIds = options?.skipMarketplaceIds
  return nextItems.map(item => {
    const previous = previousById.get(String(item.id))
    // Unscoped marketplace lists omit device rows, so account installs look
    // fully installed. Keep the previous device gap until a device-scoped
    // catalog arrives — otherwise GitHub plugin/list starts first.
    if (
      previous?.currentDeviceInstallation &&
      item.currentDeviceInstallation == null &&
      (item.installedPluginId != null || previous.installedPluginId != null)
    ) {
      item = {
        ...item,
        installedPluginId: item.installedPluginId ?? previous.installedPluginId,
        currentDeviceInstallation: previous.currentDeviceInstallation,
      }
    }
    if (item.installed && item.installedPluginId != null) return item
    if (!previous?.installed || previous.installedPluginId == null) return item
    const marketplaceId = (
      marketplaceItemMarketplaceId(item) ||
      marketplaceItemMarketplaceId(previous) ||
      ''
    )
      .trim()
      .toLowerCase()
    if (marketplaceId && skipMarketplaceIds?.has(marketplaceId)) return item
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

function liveOpenAiRemoteMarketplaceIds(installed: InstalledPluginItem[]): Set<string> {
  const ids = new Set<string>()
  for (const plugin of installed) {
    const marketplace = installedPluginMarketplaceId(plugin.raw)
    if (!marketplace || !isOpenAiOfficialRemoteMarketplaceId(marketplace)) continue
    ids.add(marketplace.trim().toLowerCase())
  }
  return ids
}

/**
 * Keep the installed strip and marketplace actions on the same snapshot when a
 * post-install catalog refresh temporarily lags behind the optimistic update.
 */
export function retainMarketplaceInstalledState(input: {
  previousItems: PluginMarketplaceItem[]
  nextItems: PluginMarketplaceItem[]
  previousInstalled: InstalledPluginItem[]
  nextInstalled: InstalledPluginItem[]
  previousStateMatchesScope: boolean
}): { items: PluginMarketplaceItem[]; installed: InstalledPluginItem[] } {
  if (!input.previousStateMatchesScope) {
    return { items: input.nextItems, installed: input.nextInstalled }
  }
  const hintedItems = retainMarketplaceInstallHints(input.previousItems, input.nextItems, {
    skipMarketplaceIds: liveOpenAiRemoteMarketplaceIds(input.nextInstalled),
  })
  const nextItemsById = new Map(input.nextItems.map(item => [String(item.id), item]))
  const retainedPluginIds = new Set(
    hintedItems.flatMap(item => {
      const next = nextItemsById.get(String(item.id))
      const retained = item.installed && !next?.installed && item.installedPluginId != null
      return retained ? [String(item.installedPluginId)] : []
    })
  )
  if (retainedPluginIds.size === 0) {
    return { items: hintedItems, installed: input.nextInstalled }
  }

  const installed = [...input.nextInstalled]
  const installedIds = new Set(installed.map(plugin => String(plugin.id)))
  for (const plugin of input.previousInstalled) {
    const id = String(plugin.id)
    if (!retainedPluginIds.has(id) || installedIds.has(id)) continue
    installed.push(plugin)
    installedIds.add(id)
  }
  const items = hintedItems.map(item => {
    const next = nextItemsById.get(String(item.id))
    const retainedId =
      item.installed && !next?.installed && item.installedPluginId != null
        ? String(item.installedPluginId)
        : null
    return retainedId && !installedIds.has(retainedId) && next ? next : item
  })
  return { items, installed }
}
