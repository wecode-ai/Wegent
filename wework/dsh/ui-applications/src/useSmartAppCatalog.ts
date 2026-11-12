import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react'
import type { SmartAppMarketplaceItem, SmartAppMarketplaceTag, SmartAppsApi } from '@/api/smartApps'
import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import { stripAppBasePath } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'

interface CatalogOwner {
  api: SmartAppsApi | null
  mode: 'marketplace' | 'owned'
  query: string
  source: 'all' | 'official' | 'public' | 'shared'
  tag: string
}

interface CloudCatalog {
  items: SmartAppMarketplaceItem[]
  marketItems: SmartAppMarketplaceItem[]
  tags: SmartAppMarketplaceTag[]
}

interface ResourceState<T> {
  owner: CatalogOwner
  requestId: number
  data: T | null
  loading: boolean
  error: string | null
}

const EMPTY_CLOUD_CATALOG: CloudCatalog = { items: [], marketItems: [], tags: [] }
const EMPTY_INSTALLATIONS: HarnessAppInstallation[] = []

function useCatalogResource<T>(owner: CatalogOwner, load: () => Promise<T>) {
  const { t } = useTranslation('common')
  const activeOwnerRef = useRef(owner)
  const requestRef = useRef(0)
  const [state, setState] = useState<ResourceState<T>>({
    owner,
    requestId: 0,
    data: null,
    loading: true,
    error: null,
  })
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    activeOwnerRef.current = owner
    stateRef.current = state
  }, [owner, state])

  const readReadyData = useCallback(() => {
    const current = stateRef.current
    return activeOwnerRef.current === owner &&
      current.owner === owner &&
      current.requestId === requestRef.current &&
      !current.loading &&
      !current.error
      ? current.data
      : null
  }, [owner])

  const invalidate = useCallback(() => {
    if (activeOwnerRef.current !== owner) return
    requestRef.current += 1
    setState(current => (current.owner === owner ? { ...current, loading: true } : current))
  }, [owner])

  const refresh = useCallback(async () => {
    if (activeOwnerRef.current !== owner) return
    const requestId = ++requestRef.current
    const isCurrent = () => requestId === requestRef.current && activeOwnerRef.current === owner
    setState(current => ({
      owner,
      requestId,
      data: current.owner === owner ? current.data : null,
      loading: true,
      error: null,
    }))
    try {
      const data = await load()
      if (isCurrent()) setState({ owner, requestId, data, loading: false, error: null })
    } catch (loadError) {
      if (!isCurrent()) return
      const error = getSmartAppErrorMessage(
        loadError,
        t('workbench.smart_apps_load_failed', '智能工作台加载失败。'),
        t
      )
      setState(current => ({ ...current, loading: false, error }))
    }
  }, [load, owner, t])

  const update = useCallback(
    (value: SetStateAction<T>) => {
      if (activeOwnerRef.current !== owner) return
      // Confirmed local changes supersede only the local discovery request.
      const requestId = ++requestRef.current
      if (state.owner !== owner || state.data === null) {
        void refresh()
        return
      }
      setState(current => {
        if (current.owner !== owner || current.data === null) return current
        const data =
          typeof value === 'function' ? (value as (previous: T) => T)(current.data) : value
        return { ...current, requestId, data, loading: false }
      })
    },
    [owner, refresh, state.data, state.owner]
  )

  useEffect(
    () => () => {
      requestRef.current += 1
    },
    []
  )
  return {
    data: state.owner === owner ? state.data : null,
    loading: state.owner !== owner || state.loading,
    error: state.owner === owner ? state.error : null,
    ready: state.owner === owner && state.data !== null && !state.loading && !state.error,
    readReadyData,
    refresh,
    invalidate,
    update,
  }
}

export function useSmartAppCatalog({ api, mode, query, source, tag }: CatalogOwner) {
  const owner = useMemo(() => ({ api, mode, query, source, tag }), [api, mode, query, source, tag])
  const loadLocal = useCallback(() => harnessAppsApi.list(), [])
  const loadCloud = useCallback(async (): Promise<CloudCatalog> => {
    if (!api) return EMPTY_CLOUD_CATALOG
    const [catalog, marketplace, tagCatalog] = await Promise.all([
      mode === 'owned'
        ? api.listOwned()
        : api.listMarketplace({
            q: query,
            source: source === 'all' ? undefined : source,
            tag: tag || undefined,
          }),
      mode === 'owned' ? api.listMarketplace() : null,
      api.listTags().catch(() => ({ version: 0, items: [] })),
    ])
    return {
      items: catalog.items,
      marketItems: marketplace?.items ?? catalog.items,
      tags: tagCatalog.items.filter(item => item.enabled).sort((a, b) => a.sort - b.sort),
    }
  }, [api, mode, query, source, tag])
  const local = useCatalogResource(owner, loadLocal)
  const cloud = useCatalogResource(owner, loadCloud)
  const refreshLocal = local.refresh
  const refreshCloud = cloud.refresh
  const [operationError, setOperationError] = useState<{
    owner: CatalogOwner
    error: string | null
  }>({
    owner,
    error: null,
  })
  const activeOwnerRef = useRef(owner)
  useLayoutEffect(() => {
    activeOwnerRef.current = owner
  }, [owner])
  const setError = useCallback(
    (error: string | null) => {
      if (activeOwnerRef.current === owner) setOperationError({ owner, error })
    },
    [owner]
  )
  const refresh = useCallback(async () => {
    setError(null)
    // Local mutations finish after local discovery; cloud discovery never gates them.
    const localRefresh = refreshLocal()
    void refreshCloud()
    await localRefresh
  }, [refreshCloud, refreshLocal, setError])
  const currentRefreshRef = useRef(refresh)
  useLayoutEffect(() => {
    currentRefreshRef.current = refresh
  }, [refresh])
  const refreshCurrentMode = useCallback(async () => {
    if (activeOwnerRef.current.mode === mode) await currentRefreshRef.current()
  }, [mode])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), query ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [refresh, query])
  useEffect(() => {
    const reenter = () => {
      const params = new URLSearchParams(window.location.search)
      if (
        stripAppBasePath(window.location.pathname) === '/sites' &&
        params.get('app_type') === 'smart_app'
      ) {
        void refresh()
      }
    }
    window.addEventListener('popstate', reenter)
    return () => window.removeEventListener('popstate', reenter)
  }, [refresh])

  const loadError = [local.error, cloud.error].filter(Boolean).join(' ')
  return {
    ...(cloud.data ?? EMPTY_CLOUD_CATALOG),
    installed: local.data ?? EMPTY_INSTALLATIONS,
    localReady: local.ready,
    localError: local.error,
    readLocalInstallations: local.readReadyData,
    loading:
      (mode === 'owned' && local.loading && local.data === null) ||
      (cloud.loading && cloud.data === null),
    error: (operationError.owner === owner ? operationError.error : null) ?? (loadError || null),
    loadError,
    refresh: refreshCurrentMode,
    invalidateRefresh: local.invalidate,
    setError,
    setInstalled: local.update,
  }
}
