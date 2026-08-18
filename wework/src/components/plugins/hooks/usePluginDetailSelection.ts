import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import type { PluginReference } from '@/features/plugins/pluginNavigation'
import { isWegentCloudMarketplace } from '@/features/plugins/pluginNavigation'
import type { PluginMarketplaceItem } from '@/types/api'
import { marketplaceItemMarketplaceId } from '../pluginDistribution'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginMarketplaceState } from '../workspace/marketplaceWorkspaceHelpers'

export function usePluginDetailSelection({
  pluginReference,
  pluginMarketplaceState,
  installedPlugins,
  selectedPluginId,
  selectedMarketplacePluginId,
  setSelectedPluginId,
  setSelectedMarketplacePluginId,
}: {
  pluginReference: PluginReference | null
  pluginMarketplaceState: PluginMarketplaceState
  installedPlugins: InstalledPluginItem[]
  selectedPluginId: string | number | null
  selectedMarketplacePluginId: string | number | null
  setSelectedPluginId: Dispatch<SetStateAction<string | number | null>>
  setSelectedMarketplacePluginId: Dispatch<SetStateAction<string | number | null>>
}) {
  const selectedPlugin = useMemo(
    () =>
      selectedPluginId === null
        ? null
        : (installedPlugins.find(plugin => plugin.id === selectedPluginId) ?? null),
    [installedPlugins, selectedPluginId]
  )
  const selectedMarketplacePlugin = useMemo(
    () =>
      selectedMarketplacePluginId === null
        ? null
        : (pluginMarketplaceState.items.find(item => item.id === selectedMarketplacePluginId) ??
          null),
    [pluginMarketplaceState.items, selectedMarketplacePluginId]
  )

  const requestedPluginName = pluginReference?.pluginName ?? null
  const requestedMarketplaceName = pluginReference?.marketplaceName ?? null
  useEffect(() => {
    if (!requestedPluginName || !requestedMarketplaceName || pluginMarketplaceState.isLoading) {
      return
    }

    const normalizedMarketplaceName = requestedMarketplaceName.toLowerCase()
    const requestedPlugin = pluginMarketplaceState.items.find(item => {
      if (item.name !== requestedPluginName) return false
      const marketplaceId = marketplaceItemMarketplaceId(item)?.toLowerCase()
      if (!marketplaceId) return isWegentCloudMarketplace(requestedMarketplaceName)
      return (
        marketplaceId === normalizedMarketplaceName ||
        (isWegentCloudMarketplace(marketplaceId) &&
          isWegentCloudMarketplace(requestedMarketplaceName))
      )
    })
    if (!requestedPlugin) return

    setSelectedPluginId(null)
    setSelectedMarketplacePluginId(current =>
      current === requestedPlugin.id ? current : requestedPlugin.id
    )
  }, [
    pluginMarketplaceState.isLoading,
    pluginMarketplaceState.items,
    requestedMarketplaceName,
    requestedPluginName,
    setSelectedMarketplacePluginId,
    setSelectedPluginId,
  ])

  return { selectedPlugin, selectedMarketplacePlugin }
}

export function openMarketplacePluginDetailSelection({
  item,
  installedPlugins,
  findPackableCreatedPlugin,
  setSelectedPluginId,
  setSelectedMarketplacePluginId,
}: {
  item: PluginMarketplaceItem
  installedPlugins: InstalledPluginItem[]
  findPackableCreatedPlugin: (
    plugins: InstalledPluginItem[],
    names: Array<string | null | undefined>
  ) => InstalledPluginItem | null
  setSelectedPluginId: Dispatch<SetStateAction<string | number | null>>
  setSelectedMarketplacePluginId: Dispatch<SetStateAction<string | number | null>>
}) {
  const installed =
    item.installedPluginId === null || item.installedPluginId === undefined
      ? null
      : (installedPlugins.find(plugin => String(plugin.id) === String(item.installedPluginId)) ??
        null)
  const packableCreated = findPackableCreatedPlugin(installedPlugins, [
    item.name,
    item.displayName,
    installed?.raw.spec.source.pluginKey,
    installed?.name,
  ])
  if (packableCreated) {
    setSelectedMarketplacePluginId(null)
    setSelectedPluginId(packableCreated.id)
    return
  }
  setSelectedPluginId(null)
  setSelectedMarketplacePluginId(item.id)
}
