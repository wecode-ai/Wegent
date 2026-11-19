import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import {
  openAiRemoteCatalog,
  RemotePluginCatalogIdentityChanged,
  RemotePluginCatalogStorageError,
  type RemotePluginCatalogSnapshot,
} from '@/api/local/codexRemoteCatalog'
import {
  detachOpenAiRemoteCatalog,
  getPluginMarketplaceAccountEpoch,
  projectOpenAiRemoteCatalog,
  subscribePluginMarketplaceCache,
} from './pluginMarketplaceCache'
import { remoteCatalogErrorKind } from './remotePluginError'

export type OpenAiPluginCatalogError = ReturnType<typeof remoteCatalogErrorKind> | 'storage'

export function useOpenAiPluginCatalog({
  cacheKey,
  accountScope,
  deviceId,
  enabled,
  restoreForAll,
  readCatalog,
}: {
  cacheKey: string
  accountScope: string
  deviceId: string
  enabled: boolean
  restoreForAll: boolean
  readCatalog: LocalCodexPluginApi['readRemoteCatalog']
}) {
  const [refreshRequest, setRefreshRequest] = useState({ cacheKey, revision: 0 })
  const revision = refreshRequest.cacheKey === cacheKey ? refreshRequest.revision : 0
  const forcedRevision = useRef<string | null>(null)
  const authRevision = useSyncExternalStore(
    subscribePluginMarketplaceCache,
    getPluginMarketplaceAccountEpoch,
    getPluginMarketplaceAccountEpoch
  )
  const [identityRevision, setIdentityRevision] = useState(0)
  const [state, setState] = useState<{
    cacheKey: string
    loading: boolean
    error: OpenAiPluginCatalogError | null
  } | null>(null)
  const refresh = useCallback(() => {
    if (enabled) setRefreshRequest(value => ({ cacheKey, revision: value.revision + 1 }))
  }, [cacheKey, enabled])

  useEffect(() => {
    return () => {
      // A later mount must verify its current identity before displaying the directory.
      // The persisted snapshot and any background refresh outlive this view.
      detachOpenAiRemoteCatalog(cacheKey)
    }
  }, [cacheKey])

  useEffect(() => {
    if (!enabled && !(restoreForAll && openAiRemoteCatalog.hasSnapshotOrRefresh())) return
    let cancelled = false
    const isCurrent = () => !cancelled && getPluginMarketplaceAccountEpoch() === authRevision
    void Promise.resolve().then(async () => {
      if (!isCurrent()) return
      const requestKey = JSON.stringify([cacheKey, revision])
      const force = enabled && revision > 0 && requestKey !== forcedRevision.current
      if (enabled) {
        forcedRevision.current = requestKey
        setState({ cacheKey, loading: true, error: null })
      }
      let cached: RemotePluginCatalogSnapshot | undefined
      try {
        const result = await readCatalog({
          forceRefetch: force,
          cacheOnly: !enabled,
          accountScope,
          canStart: isCurrent,
          onCached: (snapshot, resolvedDeviceId) => {
            cached = snapshot
            if (isCurrent()) projectOpenAiRemoteCatalog(cacheKey, resolvedDeviceId, snapshot)
          },
        })
        if (!isCurrent()) return
        if (result.deviceId && result.snapshot && result.snapshot !== cached)
          projectOpenAiRemoteCatalog(cacheKey, result.deviceId, result.snapshot)
        if (enabled) setState({ cacheKey, loading: false, error: null })
      } catch (error) {
        if (!isCurrent()) return
        if (error instanceof RemotePluginCatalogIdentityChanged) {
          detachOpenAiRemoteCatalog(cacheKey)
          setIdentityRevision(value => value + 1)
          return
        }
        if (enabled) {
          const kind =
            error instanceof RemotePluginCatalogStorageError
              ? 'storage'
              : remoteCatalogErrorKind(error)
          setState({ cacheKey, loading: false, error: kind })
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    cacheKey,
    accountScope,
    deviceId,
    enabled,
    restoreForAll,
    readCatalog,
    revision,
    authRevision,
    identityRevision,
  ])

  return {
    loading: enabled && (state?.cacheKey !== cacheKey || state.loading),
    error: enabled && state?.cacheKey === cacheKey ? state.error : null,
    refresh,
  }
}
