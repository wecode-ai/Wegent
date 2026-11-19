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
  const authRevision = useSyncExternalStore(
    subscribePluginMarketplaceCache,
    getPluginMarketplaceAccountEpoch,
    getPluginMarketplaceAccountEpoch
  )
  const [refreshRequest, setRefreshRequest] = useState<{
    cacheKey: string
    deviceId: string
    authRevision: number
    revision: number
  }>()
  const revision =
    refreshRequest?.cacheKey === cacheKey &&
    refreshRequest.deviceId === deviceId &&
    refreshRequest.authRevision === authRevision
      ? refreshRequest.revision
      : 0
  const admittedRefresh = useRef(0)
  const [identityRevision, setIdentityRevision] = useState(0)
  const [state, setState] = useState<{
    cacheKey: string
    loading: boolean
    error: OpenAiPluginCatalogError | null
  } | null>(null)
  const refresh = useCallback(() => {
    if (enabled)
      setRefreshRequest(value => ({
        cacheKey,
        deviceId,
        authRevision,
        revision: (value?.revision ?? 0) + 1,
      }))
  }, [cacheKey, deviceId, authRevision, enabled])

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
      const force = enabled && revision > admittedRefresh.current
      if (enabled) setState({ cacheKey, loading: true, error: null })
      let cached: RemotePluginCatalogSnapshot | undefined
      try {
        const result = await readCatalog({
          forceRefetch: force,
          cacheOnly: !enabled,
          accountScope,
          canStart: isCurrent,
          onCached: (snapshot, resolvedDeviceId) => {
            if (!isCurrent()) return
            // The account probe has passed and the catalog will start or join the refresh.
            if (force) admittedRefresh.current = revision
            cached = snapshot
            projectOpenAiRemoteCatalog(cacheKey, resolvedDeviceId, snapshot)
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
