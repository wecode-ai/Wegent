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

interface CatalogSnapshot {
  items: SmartAppMarketplaceItem[]
  marketItems: SmartAppMarketplaceItem[]
  installed: HarnessAppInstallation[]
  tags: SmartAppMarketplaceTag[]
}

interface CatalogState {
  owner: CatalogOwner
  snapshot: CatalogSnapshot | null
  loading: boolean
  error: string | null
}

const EMPTY_CATALOG: CatalogSnapshot = { items: [], marketItems: [], installed: [], tags: [] }

export function useSmartAppCatalog({ api, mode, query, source, tag }: CatalogOwner) {
  const { t } = useTranslation('common')
  const owner = useMemo(() => ({ api, mode, query, source, tag }), [api, mode, query, source, tag])
  const activeOwnerRef = useRef(owner)
  const requestRef = useRef(0)
  const [state, setState] = useState<CatalogState>({
    owner,
    snapshot: null,
    loading: true,
    error: null,
  })

  useLayoutEffect(() => {
    activeOwnerRef.current = owner
  }, [owner])

  const invalidateRefresh = useCallback(() => {
    if (activeOwnerRef.current === owner) requestRef.current += 1
  }, [owner])

  const refresh = useCallback(async () => {
    if (activeOwnerRef.current !== owner) return
    const requestId = ++requestRef.current
    const isCurrentRequest = () =>
      requestId === requestRef.current && activeOwnerRef.current === owner
    setState(current => {
      const snapshot = current.owner === owner ? current.snapshot : null
      return { owner, snapshot, loading: snapshot === null, error: null }
    })
    try {
      const installed = await harnessAppsApi.list()
      if (!isCurrentRequest()) return
      let snapshot: CatalogSnapshot = { ...EMPTY_CATALOG, installed }
      if (api) {
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
        snapshot = {
          installed,
          items: catalog.items,
          marketItems: marketplace?.items ?? catalog.items,
          tags: tagCatalog.items.filter(item => item.enabled).sort((a, b) => a.sort - b.sort),
        }
      }
      if (isCurrentRequest()) setState({ owner, snapshot, loading: false, error: null })
    } catch (loadError) {
      if (!isCurrentRequest()) return
      const error = getSmartAppErrorMessage(
        loadError,
        t('workbench.smart_apps_marketplace_load_failed', '智能工作台市场加载失败'),
        t
      )
      setState(current => ({ ...current, loading: false, error }))
    }
  }, [api, mode, owner, query, source, t, tag])

  const currentRefreshRef = useRef(refresh)
  useLayoutEffect(() => {
    currentRefreshRef.current = refresh
  }, [refresh])

  // A completed local mutation refreshes the current query in its original mode.
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

  useEffect(
    () => () => {
      requestRef.current += 1
    },
    []
  )

  const setError = useCallback(
    (error: string | null) => {
      if (activeOwnerRef.current !== owner) return
      setState(current => (current.owner === owner ? { ...current, error } : current))
    },
    [owner]
  )

  const setInstalled = useCallback(
    (value: SetStateAction<HarnessAppInstallation[]>) => {
      if (activeOwnerRef.current !== owner) return
      // Local lifecycle events supersede a catalog read started before the event.
      requestRef.current += 1
      if (state.owner !== owner || !state.snapshot) {
        void refresh()
        return
      }
      setState(current => {
        if (current.owner !== owner || !current.snapshot) return current
        const installed = typeof value === 'function' ? value(current.snapshot.installed) : value
        return { ...current, snapshot: { ...current.snapshot, installed } }
      })
    },
    [owner, refresh, state.owner, state.snapshot]
  )

  const isCurrentOwner = state.owner === owner
  return {
    ...(isCurrentOwner ? (state.snapshot ?? EMPTY_CATALOG) : EMPTY_CATALOG),
    loading: !isCurrentOwner || state.loading,
    error: isCurrentOwner ? state.error : null,
    refresh: refreshCurrentMode,
    invalidateRefresh,
    setError,
    setInstalled,
  }
}
