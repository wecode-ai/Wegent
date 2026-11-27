import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { pluginMarketplaceIdentity } from '@/api/local/codexPlugins'
import { isPersonalMarketplaceId } from '@/features/plugins/builtinPlugins'
import { INTERNAL_DEVICE_MARKETPLACE_ID } from '@/features/plugins/marketplaceIdentity'
import type { PluginReference } from '@/features/plugins/pluginNavigation'
import { isWegentCloudMarketplace } from '@/features/plugins/pluginNavigation'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  installedPluginMarketplaceId,
  marketplaceItemMarketplaceId,
  marketplacePluginDistribution,
} from '../pluginDistribution'
import type { InstalledPluginItem } from '../PluginManagementRows'
import {
  createdPluginSlugFromKey,
  findPackableCreatedPlugin,
  marketplaceItemOwnsLocalCreatedPackage,
} from '../pluginOwnerLocalPackage'
import type { PluginMarketplaceState } from '../workspace/marketplaceWorkspaceHelpers'
import { isLocalMarketplaceItem, localMarketplaceDedupeKey } from '../marketplaceCatalogMerge'

function localSourceIdentity(item: PluginMarketplaceItem): string | undefined {
  if (isLocalMarketplaceItem(item)) return localMarketplaceDedupeKey(item)
  if (item.visibility === 'personal' && item.accessRole === 'owner' && item.localPersonalSource)
    return `personal:${item.localPersonalSource.pluginName.trim().toLowerCase()}`
}

export function findMarketplaceItemForPluginReference(
  items: PluginMarketplaceItem[],
  reference: PluginReference | null | undefined
): PluginMarketplaceItem | null {
  const pluginName = reference?.pluginName?.trim() ?? ''
  const marketplaceName = reference?.marketplaceName?.trim() ?? ''
  if (!pluginName || !marketplaceName) return null

  const normalizedMarketplaceName = marketplaceName.toLowerCase()
  const referencesPersonalMarketplace = isPersonalMarketplaceId(normalizedMarketplaceName)
  return (
    items.find(item => {
      if (item.name !== pluginName) return false
      const marketplaceId = marketplaceItemMarketplaceId(item)?.toLowerCase()
      if (!marketplaceId) {
        const personalListing = marketplacePluginDistribution(item) === 'personal'
        if (referencesPersonalMarketplace) return personalListing
        return isWegentCloudMarketplace(marketplaceName) && !personalListing
      }
      return (
        pluginMarketplaceIdentity(item.name, marketplaceId) ===
        pluginMarketplaceIdentity(pluginName, marketplaceName)
      )
    }) ?? null
  )
}

function pluginReferenceKey(reference: PluginReference | null | undefined): string | null {
  const pluginName = reference?.pluginName?.trim() ?? ''
  const marketplaceName = reference?.marketplaceName?.trim() ?? ''
  if (!pluginName || !marketplaceName) return null
  return pluginMarketplaceIdentity(pluginName, marketplaceName)
}

export function usePluginDetailSelection({
  scopeKey,
  pluginReference,
  pluginMarketplaceState,
  installedPlugins,
  selectedPluginId,
  selectedMarketplacePluginId,
  setSelectedPluginId,
  setSelectedMarketplacePluginId,
}: {
  scopeKey: string
  pluginReference: PluginReference | null
  pluginMarketplaceState: PluginMarketplaceState
  installedPlugins: InstalledPluginItem[]
  selectedPluginId: string | number | null
  selectedMarketplacePluginId: string | number | null
  setSelectedPluginId: Dispatch<SetStateAction<string | number | null>>
  setSelectedMarketplacePluginId: Dispatch<SetStateAction<string | number | null>>
}) {
  const [dismissedReference, setDismissedReference] = useState<string | null>(null)
  const [referenceSelection, setReferenceSelection] = useState<string | null>(null)
  const selectionKey = JSON.stringify([scopeKey, selectedMarketplacePluginId])
  const [localSelection, setLocalSelection] = useState<{
    key: string
    identity?: string
  }>({ key: selectionKey })
  const localIdentity = localSelection.key === selectionKey ? localSelection.identity : undefined
  const selectedPlugin = useMemo(
    () =>
      selectedPluginId === null
        ? null
        : (installedPlugins.find(plugin => plugin.id === selectedPluginId) ?? null),
    [installedPlugins, selectedPluginId]
  )
  const selectedMarketplacePlugin = useMemo(() => {
    if (selectedMarketplacePluginId === null) return null
    const direct = pluginMarketplaceState.items.find(
      item => item.id === selectedMarketplacePluginId
    )
    if (direct) return direct
    // Background publication can replace the same author source's disk-only row.
    const matches = localIdentity
      ? pluginMarketplaceState.items.filter(item => localSourceIdentity(item) === localIdentity)
      : []
    return matches.length === 1 ? matches[0] : null
  }, [localIdentity, pluginMarketplaceState.items, selectedMarketplacePluginId])
  const selectedLocalIdentity = selectedMarketplacePlugin
    ? localSourceIdentity(selectedMarketplacePlugin)
    : undefined
  if (localSelection.key !== selectionKey || localSelection.identity !== selectedLocalIdentity) {
    setLocalSelection({ key: selectionKey, identity: selectedLocalIdentity })
  }

  const referenceKey = pluginReferenceKey(pluginReference)
  const requestedPlugin = findMarketplaceItemForPluginReference(
    pluginMarketplaceState.items,
    pluginReference
  )
  const installedByReference = useMemo(
    () =>
      new Map(
        installedPlugins.map(plugin => [
          pluginMarketplaceIdentity(
            plugin.raw.spec.source.pluginKey,
            installedPluginMarketplaceId(plugin.raw) || INTERNAL_DEVICE_MARKETPLACE_ID
          ),
          plugin,
        ])
      ),
    [installedPlugins]
  )
  const requestedInstalledPlugin = referenceKey ? installedByReference.get(referenceKey) : null
  const requestedCreatedPlugin = useMemo(
    () =>
      requestedPlugin &&
      (requestedPlugin.visibility === 'personal' ||
        (requestedPlugin.latestReleaseId == null &&
          marketplacePluginDistribution(requestedPlugin) === 'personal'))
        ? findMarketplaceCreatedPlugin(requestedPlugin, installedPlugins, findPackableCreatedPlugin)
        : null,
    [requestedPlugin, installedPlugins]
  )
  const requestedSelection = JSON.stringify([
    scopeKey,
    referenceKey,
    requestedPlugin?.id ?? null,
    requestedInstalledPlugin?.id ?? null,
    requestedCreatedPlugin?.id ?? null,
  ])
  if (referenceSelection !== requestedSelection) {
    setReferenceSelection(requestedSelection)
    if (!referenceKey) {
      if (dismissedReference !== null) setDismissedReference(null)
    } else if (dismissedReference !== referenceKey && requestedCreatedPlugin) {
      // These setters belong to the same component that owns this hook.
      setSelectedMarketplacePluginId(null)
      setSelectedPluginId(requestedCreatedPlugin.id)
    } else if (dismissedReference !== referenceKey && requestedPlugin) {
      if (selectedPluginId !== null) setSelectedPluginId(null)
      if (selectedMarketplacePluginId !== requestedPlugin.id)
        setSelectedMarketplacePluginId(requestedPlugin.id)
    } else if (dismissedReference !== referenceKey && requestedInstalledPlugin) {
      setSelectedMarketplacePluginId(null)
      setSelectedPluginId(requestedInstalledPlugin.id)
    }
  }

  const dismissPluginReferenceDetail = useCallback(() => {
    setDismissedReference(pluginReferenceKey(pluginReference))
    setSelectedPluginId(null)
    setSelectedMarketplacePluginId(null)
  }, [pluginReference, setSelectedMarketplacePluginId, setSelectedPluginId])

  return { selectedPlugin, selectedMarketplacePlugin, dismissPluginReferenceDetail }
}

interface MarketplaceDetailSelection {
  item: PluginMarketplaceItem
  installedPlugins: InstalledPluginItem[]
  findPackableCreatedPlugin: typeof findPackableCreatedPlugin
  setSelectedPluginId: Dispatch<SetStateAction<string | number | null>>
  setSelectedMarketplacePluginId: Dispatch<SetStateAction<string | number | null>>
}

function findMarketplaceCreatedPlugin(
  item: PluginMarketplaceItem,
  installedPlugins: InstalledPluginItem[],
  findPackable: typeof findPackableCreatedPlugin
): InstalledPluginItem | null {
  const installed =
    item.installedPluginId === null || item.installedPluginId === undefined
      ? null
      : (installedPlugins.find(plugin => String(plugin.id) === String(item.installedPluginId)) ??
        null)
  return marketplaceItemOwnsLocalCreatedPackage(item)
    ? findPackable(installedPlugins, [
        item.name,
        createdPluginSlugFromKey(item.name),
        item.displayName,
        installed?.raw.spec.source.pluginKey,
        installed?.name,
      ])
    : null
}

export function openMarketplacePluginDetailSelection({
  item,
  installedPlugins,
  findPackableCreatedPlugin,
  setSelectedPluginId,
  setSelectedMarketplacePluginId,
}: MarketplaceDetailSelection) {
  const packableCreated = findMarketplaceCreatedPlugin(
    item,
    installedPlugins,
    findPackableCreatedPlugin
  )
  if (packableCreated) {
    setSelectedMarketplacePluginId(null)
    setSelectedPluginId(packableCreated.id)
    return
  }
  setSelectedPluginId(null)
  setSelectedMarketplacePluginId(item.id)
}
