import { isOpenAiOfficialRemoteMarketplaceId } from '@/features/plugins/marketplaceIdentity'

import { startTransition } from 'react'

import {
  getPluginMarketplaceCache,
  sameInstalledPlugins,
  sameMarketplaceItems,
  setPluginMarketplaceCache,
} from '@/features/plugins/pluginMarketplaceCache'

import {
  indexLocalPluginSources,
  resolveLocalPluginInventory,
} from '@/features/plugins/pluginInventorySources'

import { marketplaceItemNeedsDeviceSync } from '@/features/plugins/pluginDeviceAutoSync'

import { holdBackInFlightMarketplaceInstalls } from '../holdBackInFlightMarketplaceInstalls'

import { mergeInstalledPlugins, storeDirMatchesPluginKey } from '../installedPluginMerge'

import { mergeMarketplaceCatalog } from '../marketplaceCatalogMerge'

import { marketplaceItemMarketplaceId } from '../pluginDistribution'

import {
  isCodexCatalogItem,
  toInstalledPluginItem,
  toMarketplaceOptions,
} from '../workspace/marketplaceWorkspaceHelpers'

import type { PluginCatalogContext } from './pluginCatalogState'

export function applyLivePluginCatalog(
  ctx: PluginCatalogContext,
  localState: Awaited<ReturnType<typeof ctx.input.localPluginApi.readState>>
) {
  const deviceId =
    ctx.input.knownExecutorDeviceId || localState.deviceId || ctx.state.currentDeviceId || ''
  const localInventory = resolveLocalPluginInventory(
    getPluginMarketplaceCache(ctx.key),
    {
      items: localState.installedPlugins,
      deviceId: localState.deviceId,
      partial: localState.partial,
      sourceReads: localState.sourceReads,
    },
    deviceId
  )
  const localInstalled = localInventory.items
  startTransition(() => {
    const previousItems = ctx.catalog.items
    const previousCloudItems = previousItems.filter(item => !isCodexCatalogItem(item))
    // An empty plugin/list (GitHub timeout) must not rebuild cloud rows that
    // still need wegent ZIP/install; that would drop pending and release the
    // shared Codex lock to a hung GitHub reconcile.
    if (
      localState.marketplaceItems.length === 0 &&
      previousCloudItems.some(marketplaceItemNeedsDeviceSync)
    ) {
      if (import.meta.env.VITE_WEWORK_E2E === 'true')
        console.info('[plugin-catalog-publication] retained-pending-catalog')
      if (localState.deviceId) ctx.publish({ currentDeviceId: localState.deviceId })
      ctx.publish({ isMarketplaceRefreshing: false })
      return
    }
    ctx.publish({ currentDeviceId: localState.deviceId })
    ctx.applyLocalMarketplaceState(localState)
    const cloudInstalledRaw = ctx.state.installedPlugins
      .map(plugin => plugin.raw)
      .filter(plugin => typeof plugin.spec.pluginId === 'number')
    const nextInstalledRaw = mergeInstalledPlugins(
      cloudInstalledRaw,
      localInstalled,
      localState.deviceId || ctx.state.currentDeviceId || '',
      ctx.ledger.cloudMembershipAuthoritative
    ).map(toInstalledPluginItem)
    // Keep existing cloud rows (device pending/failed inclusive). Only refresh the
    // Codex/OpenAI slice from plugin/list so retain hints cannot invent
    // installedLocally=true on account installs that still need device sync.
    const previousById = new Map(ctx.catalog.items.map(item => [String(item.id), item] as const))
    const localPluginKeys = new Set(
      localInstalled.flatMap(plugin => {
        const name = String(plugin.spec.source.pluginKey || plugin.metadata.name || '')
          .trim()
          .toLowerCase()
        const id = String(
          plugin.spec.source.catalogItemId ||
            (plugin.metadata.labels && typeof plugin.metadata.labels === 'object'
              ? (plugin.metadata.labels as Record<string, unknown>).id
              : '') ||
            ''
        )
          .trim()
          .toLowerCase()
        const keys = [name, id]
        const pluginId = plugin.spec.pluginId
        if (typeof pluginId === 'number') keys.push(String(pluginId))
        const prefix = /^(\d+)-/.exec(id)
        if (prefix) keys.push(prefix[1])
        return keys.filter(Boolean)
      })
    )
    const localStoreDirs = localInstalled.flatMap(plugin => {
      const id = String(
        plugin.spec.source.catalogItemId ||
          (plugin.metadata.labels && typeof plugin.metadata.labels === 'object'
            ? (plugin.metadata.labels as Record<string, unknown>).id
            : '') ||
          plugin.metadata.name ||
          ''
      )
      return id ? [id] : []
    })
    const nextItems = mergeMarketplaceCatalog(
      ctx.catalog.items.filter(item => !isCodexCatalogItem(item)),
      [
        ...previousItems.filter(item =>
          isOpenAiOfficialRemoteMarketplaceId(marketplaceItemMarketplaceId(item))
        ),
        ...localState.marketplaceItems,
      ],
      nextInstalledRaw.map(plugin => plugin.raw)
    ).map(item => {
      const previous = previousById.get(String(item.id))
      const withDeviceState = previous?.currentDeviceInstallation
        ? {
            ...item,
            currentDeviceInstallation:
              item.currentDeviceInstallation ?? previous.currentDeviceInstallation,
          }
        : item
      if (isCodexCatalogItem(withDeviceState)) return withDeviceState
      const catalogName = String(withDeviceState.name).trim().toLowerCase()
      const catalogId = String(withDeviceState.id)
      if (
        withDeviceState.installedLocally &&
        !localPluginKeys.has(catalogName) &&
        !localPluginKeys.has(catalogId) &&
        !localStoreDirs.some(dirName => storeDirMatchesPluginKey(dirName, withDeviceState.name))
      ) {
        return { ...withDeviceState, installedLocally: false }
      }
      return withDeviceState
    })
    const heldBack = holdBackInFlightMarketplaceInstalls({
      items: nextItems,
      installed: nextInstalledRaw,
      installingIds: ctx.input.installingMarketplacePluginIds,
      authPluginKey:
        ctx.input.pendingLocalConnectorAuth?.purpose === 'install'
          ? ctx.input.pendingLocalConnectorAuth.target.pluginKey
          : null,
    })
    const nextInstalled = heldBack.installed
    ctx.publish({
      installedPlugins: (previous =>
        sameInstalledPlugins(previous, nextInstalled) ? previous : nextInstalled)(
        ctx.state.installedPlugins
      ),
    })
    const cachedSnapshot = getPluginMarketplaceCache(ctx.key)
    if (cachedSnapshot) {
      setPluginMarketplaceCache(
        {
          ...cachedSnapshot,
          marketplaceItems: heldBack.items,
          installedPlugins: nextInstalled.map(plugin => plugin.raw),
          localInstalledSources: indexLocalPluginSources(
            nextInstalled.map(plugin => plugin.raw),
            localInventory.sourceItems,
            deviceId
          ),
          localInstalledSourceStatus: localInventory.localInstalledSourceStatus,
          marketplaces: toMarketplaceOptions(
            localState.marketplaces,
            ctx.input.cloudMarketplaceAvailable,
            ctx.input.t('workbench.plugins_wework_cloud_marketplace', 'Wework 云端市场')
          ),
          deviceId,
          fetchedAt: Date.now(),
        },
        { persistImmediately: true }
      )
    }
    ctx.publish({
      marketplaceCatalogState: (previous => {
        const items = heldBack.items
        if (sameMarketplaceItems(previous.items, items) && !previous.error) {
          return { ...previous, isLoading: false, error: null }
        }
        return {
          items: getPluginMarketplaceCache(ctx.key)?.marketplaceItems ?? items,
          isLoading: false,
          error: null,
        }
      })(ctx.state.marketplaceCatalogState),
    })
    ctx.publish({ isMarketplaceRefreshing: false })
  })
}
