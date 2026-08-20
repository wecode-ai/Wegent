import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import type { PluginReference } from '@/features/plugins/pluginNavigation'
import { isWegentCloudMarketplace } from '@/features/plugins/pluginNavigation'
import type { PluginMarketplaceItem } from '@/types/api'
import { marketplaceItemMarketplaceId } from '../pluginDistribution'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { marketplaceItemOwnsLocalCreatedPackage } from '../pluginOwnerLocalPackage'
import type { PluginMarketplaceState } from '../workspace/marketplaceWorkspaceHelpers'

export function findMarketplaceItemForPluginReference(
  items: PluginMarketplaceItem[],
  reference: PluginReference | null | undefined
): PluginMarketplaceItem | null {
  const pluginName = reference?.pluginName?.trim() ?? ''
  const marketplaceName = reference?.marketplaceName?.trim() ?? ''
  if (!pluginName || !marketplaceName) return null

  const normalizedMarketplaceName = marketplaceName.toLowerCase()
  return (
    items.find(item => {
      if (item.name !== pluginName) return false
      const marketplaceId = marketplaceItemMarketplaceId(item)?.toLowerCase()
      if (!marketplaceId) return isWegentCloudMarketplace(marketplaceName)
      return (
        marketplaceId === normalizedMarketplaceName ||
        (isWegentCloudMarketplace(marketplaceId) && isWegentCloudMarketplace(marketplaceName))
      )
    }) ?? null
  )
}

function pluginReferenceKey(reference: PluginReference | null | undefined): string | null {
  const pluginName = reference?.pluginName?.trim() ?? ''
  const marketplaceName = reference?.marketplaceName?.trim() ?? ''
  if (!pluginName || !marketplaceName) return null
  return `${pluginName}@${marketplaceName}`.toLowerCase()
}

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
  const dismissedPluginReferenceKeyRef = useRef<string | null>(null)
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

  useEffect(() => {
    const referenceKey = pluginReferenceKey(pluginReference)
    if (!referenceKey) {
      dismissedPluginReferenceKeyRef.current = null
      return
    }
    if (dismissedPluginReferenceKeyRef.current === referenceKey) return

    const requestedPlugin = findMarketplaceItemForPluginReference(
      pluginMarketplaceState.items,
      pluginReference
    )
    if (!requestedPlugin) return

    setSelectedPluginId(null)
    setSelectedMarketplacePluginId(current =>
      current === requestedPlugin.id ? current : requestedPlugin.id
    )
  }, [
    pluginMarketplaceState.items,
    pluginReference,
    setSelectedMarketplacePluginId,
    setSelectedPluginId,
  ])

  const dismissPluginReferenceDetail = useCallback(() => {
    dismissedPluginReferenceKeyRef.current = pluginReferenceKey(pluginReference)
    setSelectedPluginId(null)
    setSelectedMarketplacePluginId(null)
  }, [pluginReference, setSelectedMarketplacePluginId, setSelectedPluginId])

  return { selectedPlugin, selectedMarketplacePlugin, dismissPluginReferenceDetail }
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
  const packableCreated = marketplaceItemOwnsLocalCreatedPackage(item)
    ? findPackableCreatedPlugin(installedPlugins, [
        item.name,
        item.displayName,
        installed?.raw.spec.source.pluginKey,
        installed?.name,
      ])
    : null
  if (packableCreated) {
    setSelectedMarketplacePluginId(null)
    setSelectedPluginId(packableCreated.id)
    return
  }
  setSelectedPluginId(null)
  setSelectedMarketplacePluginId(item.id)
}
