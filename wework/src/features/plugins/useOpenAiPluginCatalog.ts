import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginMarketplaceItem } from '@/types/api'
import { applyInstalledPluginsToMarketplaceItems } from '@/api/local/codexPlugins'
import { isOpenAiOfficialRemoteMarketplaceId } from './marketplaceIdentity'
import { getPluginMarketplaceCache, setPluginMarketplaceCache } from './pluginMarketplaceCache'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { remoteCatalogErrorKind } from './remotePluginError'

const REQUEST_TIMEOUT_MS = 30_000

export function useOpenAiPluginCatalog({
  cacheKey,
  enabled,
  readCatalog,
}: {
  cacheKey: string
  enabled: boolean
  readCatalog: (options: {
    forceRefetch: boolean
    accountScope: string
  }) => Promise<{ items: PluginMarketplaceItem[]; deviceId: string }>
}) {
  const [refreshRequest, setRefreshRequest] = useState({ cacheKey, revision: 0 })
  const revision = refreshRequest.cacheKey === cacheKey ? refreshRequest.revision : 0
  const forcedRevision = useRef<string | null>(null)
  const [state, setState] = useState<{
    cacheKey: string
    loading: boolean
    error: ReturnType<typeof remoteCatalogErrorKind> | null
  }>({ cacheKey, loading: false, error: null })
  const refresh = useCallback(() => {
    if (enabled) setRefreshRequest(value => ({ cacheKey, revision: value.revision + 1 }))
  }, [cacheKey, enabled])
  const requested = enabled

  useEffect(() => {
    if (!requested) return
    let cancelled = false
    void Promise.resolve().then(async () => {
      if (cancelled) return
      const initial = getPluginMarketplaceCache(cacheKey)
      const requestKey = JSON.stringify([cacheKey, revision])
      const force = revision > 0 && requestKey !== forcedRevision.current
      // The API owns freshness after validating the current device and auth fingerprint.
      forcedRevision.current = requestKey
      setState({ cacheKey, loading: true, error: null })
      try {
        const result = await raceWithTimeout(
          readCatalog({ forceRefetch: force, accountScope: cacheKey }),
          REQUEST_TIMEOUT_MS,
          () => new Error('Remote plugin catalog timed out')
        )
        if (cancelled) return
        const current = getPluginMarketplaceCache(cacheKey)
        if (current?.deviceId && current.deviceId !== result.deviceId) return
        // Another mounted consumer may already have published a newer catalog.
        if ((current?.openAiCatalogFetchedAt ?? 0) > (initial?.openAiCatalogFetchedAt ?? 0)) return
        const isRemote = (item: PluginMarketplaceItem) =>
          isOpenAiOfficialRemoteMarketplaceId(
            typeof item.manifest?.marketplaceId === 'string' ? item.manifest.marketplaceId : null
          )
        // Catalog responses never carry installation authority. Project the newest
        // shared membership, including mutations accepted during this request.
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
      } catch (error) {
        if (!cancelled) setState({ cacheKey, loading: false, error: remoteCatalogErrorKind(error) })
      } finally {
        if (!cancelled) setState(value => ({ ...value, loading: false }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [cacheKey, requested, readCatalog, revision])

  return {
    loading: state.cacheKey === cacheKey && state.loading,
    error: state.cacheKey === cacheKey ? state.error : null,
    refresh,
  }
}
