import type { PluginMarketplaceItem } from '@/types/api'
import { applyInstalledPluginsToMarketplaceItems } from '@/api/local/codexPlugins'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { isOpenAiOfficialRemoteMarketplaceId } from './marketplaceIdentity'
import {
  getPluginMarketplaceAccountEpoch,
  getPluginMarketplaceCache,
  setPluginMarketplaceCache,
} from './pluginMarketplaceCache'

export type OpenAiPluginCatalogReader = (options: {
  forceRefetch: boolean
  accountScope: string
}) => Promise<{ items: PluginMarketplaceItem[]; deviceId: string }>

/** Read catalog metadata without granting it installation authority. */
export function createOpenAiPluginCatalogResource(
  cacheKey: string,
  readCatalog: OpenAiPluginCatalogReader
) {
  let forceRefetch = false
  const resource = createAsyncResource(
    cacheKey,
    async signal => {
      const epoch = getPluginMarketplaceAccountEpoch()
      const initial = getPluginMarketplaceCache(cacheKey)
      const force = forceRefetch
      forceRefetch = false
      const result = await raceWithTimeout(
        readCatalog({ forceRefetch: force, accountScope: cacheKey }),
        30_000,
        () => new Error('Remote plugin catalog timed out')
      )
      signal.throwIfAborted()
      if (epoch !== getPluginMarketplaceAccountEpoch()) return result
      const current = getPluginMarketplaceCache(cacheKey)
      if (current?.deviceId && current.deviceId !== result.deviceId) return result
      if ((current?.openAiCatalogFetchedAt ?? 0) > (initial?.openAiCatalogFetchedAt ?? 0))
        return result
      const isRemote = (item: PluginMarketplaceItem) =>
        isOpenAiOfficialRemoteMarketplaceId(
          typeof item.manifest?.marketplaceId === 'string' ? item.manifest.marketplaceId : null
        )
      // Use current membership so in-flight catalog reads cannot undo confirmed installation changes.
      setPluginMarketplaceCache(
        {
          cacheKey,
          deviceId: result.deviceId,
          marketplaceItems: [
            ...(current?.marketplaceItems ?? []).filter(item => !isRemote(item)),
            ...applyInstalledPluginsToMarketplaceItems(
              result.items,
              current?.installedPlugins ?? []
            ),
          ],
          installedPlugins: current?.installedPlugins ?? [],
          marketplaces: current?.marketplaces ?? [],
          selectedMarketplaceKey: current?.selectedMarketplaceKey ?? '',
          fetchedAt: Date.now(),
          openAiCatalogFetchedAt: Date.now(),
        },
        { remoteCatalog: true }
      )
      return result
    },
    { refreshOnSubscribe: true }
  )
  return {
    ...resource,
    refresh() {
      if (!resource.hasSubscribers()) return
      forceRefetch = true
      void resource.reload()
    },
  }
}
