import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { stripAppBasePath } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import {
  createSmartAppCatalogStore,
  EMPTY_CLOUD_CATALOG,
  EMPTY_INSTALLATIONS,
  type CatalogOwner,
} from './smartAppCatalogStore'

export function useSmartAppCatalog({ api, mode, query, source, tag }: CatalogOwner) {
  const { t } = useTranslation('common')
  const [store] = useState(createSmartAppCatalogStore)
  const owner = useMemo(() => ({ api, mode, query, source, tag }), [api, mode, query, source, tag])
  const view = useMemo(() => store.observe(owner), [store, owner])
  const subscribe = useCallback((listener: () => void) => view.subscribe(listener, t), [view, t])
  const snapshot = useSyncExternalStore(subscribe, view.getSnapshot)
  const refresh = useCallback(() => store.refreshMode(mode), [store, mode])
  useDOMEvent<PopStateEvent>('window', 'popstate', () => {
    const params = new URLSearchParams(window.location.search)
    if (
      stripAppBasePath(window.location.pathname) === '/sites' &&
      params.get('app_type') === 'smart_app'
    )
      void refresh()
  })
  const { local, cloud, operationError } = snapshot
  const loadError = [local.error, cloud.error].filter(Boolean).join(' ')
  return {
    ...(cloud.data ?? EMPTY_CLOUD_CATALOG),
    installed: local.data ?? EMPTY_INSTALLATIONS,
    localReady: local.data !== null && !local.loading && !local.error,
    localError: local.error,
    readLocalInstallations: view.readReadyData,
    loading:
      (mode === 'owned' && local.loading && local.data === null) ||
      (cloud.loading && cloud.data === null),
    error: operationError ?? (loadError || null),
    loadError,
    refresh,
    invalidateRefresh: view.invalidate,
    setError: view.setError,
    setInstalled: view.update,
  }
}
