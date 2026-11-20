import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { RemotePluginCatalogStorageError } from '@/api/local/codexRemoteCatalog'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { remoteCatalogErrorKind } from './remotePluginError'
import {
  createOpenAiPluginCatalogResource,
  type OpenAiPluginCatalogReader,
} from './openAiPluginCatalogResource'
import {
  getPluginMarketplaceAccountEpoch,
  subscribePluginMarketplaceCache,
} from './pluginMarketplaceCache'

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
  readCatalog: OpenAiPluginCatalogReader
}) {
  const resource = useMemo(
    () => createOpenAiPluginCatalogResource(cacheKey, accountScope, deviceId, readCatalog),
    [cacheKey, accountScope, deviceId, readCatalog]
  )
  const epoch = useSyncExternalStore(
    subscribePluginMarketplaceCache,
    getPluginMarketplaceAccountEpoch,
    getPluginMarketplaceAccountEpoch
  )
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, !enabled, epoch),
    [enabled, epoch, resource]
  )
  const active = enabled || (restoreForAll && isElectronRuntime())
  const snapshot = useSyncExternalStore(
    active ? subscribe : subscribeIdleResource,
    resource.getSnapshot
  )
  const error: OpenAiPluginCatalogError | null =
    enabled && snapshot.status === 'error'
      ? snapshot.error instanceof RemotePluginCatalogStorageError
        ? 'storage'
        : remoteCatalogErrorKind(snapshot.error)
      : null
  return {
    loading: enabled && (snapshot.status === 'idle' || snapshot.status === 'loading'),
    error,
    refresh: resource.refresh,
  }
}
