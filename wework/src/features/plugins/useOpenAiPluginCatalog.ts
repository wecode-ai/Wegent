import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { remoteCatalogErrorKind } from './remotePluginError'
import {
  createOpenAiPluginCatalogResource,
  type OpenAiPluginCatalogReader,
} from './openAiPluginCatalogResource'

export function useOpenAiPluginCatalog({
  cacheKey,
  enabled,
  readCatalog,
}: {
  cacheKey: string
  enabled: boolean
  readCatalog: OpenAiPluginCatalogReader
}) {
  const resource = useMemo(
    () => createOpenAiPluginCatalogResource(cacheKey, readCatalog),
    [cacheKey, readCatalog]
  )
  const snapshot = useSyncExternalStore(
    enabled ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot
  )
  const refresh = useCallback(() => {
    if (enabled) resource.refresh()
  }, [enabled, resource])
  return {
    loading: enabled && (snapshot.status === 'idle' || snapshot.status === 'loading'),
    error: snapshot.status === 'error' ? remoteCatalogErrorKind(snapshot.error) : null,
    refresh,
  }
}
