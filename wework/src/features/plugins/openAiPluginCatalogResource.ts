import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import {
  openAiRemoteCatalog,
  RemotePluginCatalogIdentityChanged,
  type RemotePluginCatalogSnapshot,
} from '@/api/local/codexRemoteCatalog'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import {
  detachOpenAiRemoteCatalog,
  getPluginMarketplaceAccountEpoch,
  projectOpenAiRemoteCatalog,
} from './pluginMarketplaceCache'

export type OpenAiPluginCatalogReader = LocalCodexPluginApi['readRemoteCatalog']

export function createOpenAiPluginCatalogResource(
  cacheKey: string,
  accountScope: string,
  deviceId: string,
  readCatalog: OpenAiPluginCatalogReader
) {
  let cacheOnly = false
  let refreshEpoch: number | undefined
  const resource = createAsyncResource(JSON.stringify([cacheKey, deviceId]), load, {
    refreshOnSubscribe: true,
  })

  async function load(signal: AbortSignal): Promise<void> {
    const epoch = getPluginMarketplaceAccountEpoch()
    const restoreOnly = cacheOnly
    const isCurrent = () => !signal.aborted && epoch === getPluginMarketplaceAccountEpoch()
    if (restoreOnly && !(await openAiRemoteCatalog.hasSnapshotOrRefresh())) return
    if (!isCurrent()) return

    const force = !restoreOnly && refreshEpoch === epoch
    let cached: RemotePluginCatalogSnapshot | undefined
    try {
      const result = await readCatalog({
        forceRefetch: force,
        cacheOnly: restoreOnly,
        accountScope,
        canStart: isCurrent,
        onCached: (snapshot, deviceId) => {
          if (!isCurrent()) return
          // Consume a manual refresh only after the identity and disk checks pass.
          if (force) refreshEpoch = undefined
          cached = snapshot
          if (snapshot) projectOpenAiRemoteCatalog(cacheKey, deviceId, snapshot)
          else detachOpenAiRemoteCatalog(cacheKey)
        },
      })
      if (isCurrent() && result.deviceId && result.snapshot && result.snapshot !== cached)
        projectOpenAiRemoteCatalog(cacheKey, result.deviceId, result.snapshot)
    } catch (error) {
      if (!(error instanceof RemotePluginCatalogIdentityChanged) || !isCurrent()) throw error
      detachOpenAiRemoteCatalog(cacheKey)
      void resource.reload()
    }
  }

  return {
    getSnapshot: resource.getSnapshot,
    subscribe(listener: () => void, restoreOnly: boolean, epoch: number) {
      cacheOnly = restoreOnly
      const unsubscribe = resource.subscribe(listener, epoch)
      return () => {
        unsubscribe()
        if (resource.hasSubscribers()) return
        // Changing between Official and All replaces the subscription in the same commit.
        queueMicrotask(() => {
          if (!resource.hasSubscribers() && epoch === getPluginMarketplaceAccountEpoch())
            detachOpenAiRemoteCatalog(cacheKey)
        })
      }
    },
    refresh() {
      if (cacheOnly || !resource.hasSubscribers()) return
      refreshEpoch = getPluginMarketplaceAccountEpoch()
      void resource.reload()
    },
  }
}
