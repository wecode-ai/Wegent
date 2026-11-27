import { createAsyncResource } from '@wegent/chat-core/async-resource'
import {
  isSitesUnavailableError,
  type SiteAppType,
  type SiteListItem,
  type SitesApi,
} from '@/api/sites'

interface CollectionState {
  searchInput: string
  query: string
  items: SiteListItem[]
  total: number
  loading: boolean
  loadingMore: boolean
  failure: { cause: unknown } | null
  unavailable: boolean
}

/** One visible application type owns its search, reads and accepted list changes. */
export function createApplicationCollection(
  api: SitesApi,
  appType: SiteAppType,
  pageSize: number,
  enabled: boolean
) {
  const listeners = new Set<() => void>()
  let state: CollectionState = {
    searchInput: '',
    query: '',
    items: [],
    total: 0,
    loading: enabled,
    loadingMore: false,
    failure: null,
    unavailable: false,
  }
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopRead: (() => void) | undefined
  const publish = (patch: Partial<CollectionState>) => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const createQuery = (text: string) =>
    createAsyncResource('applications', async () => {
      const response = await api.listSites({ appType, q: text, offset: 0, limit: pageSize })
      return {
        items: response.items.filter(item => item.app_type === appType),
        total: response.total,
      }
    })
  let query = createQuery('')
  const publishQuery = () => {
    const snapshot = query.getSnapshot()
    generation++
    if (snapshot.status === 'loading') {
      publish({ loading: true, loadingMore: false, failure: null })
    } else if (snapshot.status === 'ready' && snapshot.data) {
      publish({
        ...snapshot.data,
        loading: false,
        loadingMore: false,
        failure: null,
        unavailable: false,
      })
    } else if (snapshot.status === 'error') {
      const unavailable = isSitesUnavailableError(snapshot.error)
      publish({
        items: [],
        total: 0,
        loading: false,
        loadingMore: false,
        unavailable,
        failure: unavailable ? null : { cause: snapshot.error },
      })
    }
  }
  const commitSearch = () => {
    timer = undefined
    const text = state.searchInput.trim()
    if (!listeners.size || text === state.query) return
    stopRead?.()
    query = createQuery(text)
    publish({ query: text, items: [], total: 0, loading: true, loadingMore: false, failure: null })
    if (listeners.size) stopRead = query.subscribe(publishQuery)
  }
  const scheduleSearch = () => {
    clearTimeout(timer)
    timer = undefined
    if (enabled && listeners.size && state.searchInput.trim() !== state.query) {
      timer = setTimeout(commitSearch, 180)
    }
  }
  const update = (change: (current: CollectionState) => Partial<CollectionState>) => {
    if (!enabled || !listeners.size) return
    const next = { ...state, ...change(state) }
    query.update(() => ({ items: next.items, total: next.total }))
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (enabled && listeners.size === 1) {
        stopRead = query.subscribe(publishQuery)
        scheduleSearch()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          generation++
          clearTimeout(timer)
          timer = undefined
          stopRead?.()
          stopRead = undefined
          state = { ...state, loadingMore: false }
        }
      }
    },
    changeSearch(value: string) {
      if (!enabled || !listeners.size) return
      publish({ searchInput: value })
      scheduleSearch()
    },
    resetSearch() {
      if (!enabled || !listeners.size) return
      clearTimeout(timer)
      timer = undefined
      publish({ searchInput: '' })
      commitSearch()
    },
    loadFirstPage: () => (enabled && listeners.size ? query.reload() : Promise.resolve()),
    async loadMore() {
      if (
        !enabled ||
        !listeners.size ||
        state.loading ||
        state.loadingMore ||
        state.items.length >= state.total
      )
        return
      const current = generation
      const text = state.query
      const offset = state.items.length
      publish({ loadingMore: true, failure: null })
      try {
        const page = await api.listSites({ appType, q: text, offset, limit: pageSize })
        if (!listeners.size || current !== generation) return
        update(currentState => ({
          items: [...currentState.items, ...page.items.filter(item => item.app_type === appType)],
          total: page.total,
        }))
      } catch (error) {
        if (!listeners.size || current !== generation) return
        const unavailable = isSitesUnavailableError(error)
        publish({
          unavailable,
          failure: unavailable ? null : { cause: error },
          ...(unavailable ? { items: [], total: 0 } : {}),
        })
      } finally {
        if (listeners.size && current === generation) publish({ loadingMore: false })
      }
    },
    setItems: (change: (items: SiteListItem[]) => SiteListItem[]) =>
      update(current => ({ items: change(current.items) })),
    removeSite(siteId: string) {
      if (!state.items.some(item => item.siteid === siteId)) return
      update(current => ({
        items: current.items.filter(item => item.siteid !== siteId),
        total: Math.max(0, current.total - 1),
      }))
    },
  }
}
