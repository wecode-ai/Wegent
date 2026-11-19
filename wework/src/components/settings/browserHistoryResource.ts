import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { clearEmbeddedBrowserData } from '@/lib/embedded-browser'
import {
  embeddedBrowserHistoryNextCursor,
  removeEmbeddedBrowserHistoryEntries,
  searchEmbeddedBrowserHistory,
  type EmbeddedBrowserHistoryCursor,
  type EmbeddedBrowserHistoryEntry,
} from '@/lib/embedded-browser-history'

interface HistoryState {
  searchInput: string
  query: string
  entries: EmbeddedBrowserHistoryEntry[]
  cursor: EmbeddedBrowserHistoryCursor | null
  firstPageVersion: number
  loading: boolean
  loadingMore: boolean
  loadError: boolean
  paginationError: boolean
  removing: boolean
  clearing: boolean
  actionFailed: boolean
}

/** One active history page owns search debounce, reads, pagination and accepted mutations. */
export function createBrowserHistoryResource() {
  const listeners = new Set<() => void>()
  let state: HistoryState = {
    searchInput: '',
    query: '',
    entries: [],
    cursor: null,
    firstPageVersion: 0,
    loading: true,
    loadingMore: false,
    loadError: false,
    paginationError: false,
    removing: false,
    clearing: false,
    actionFailed: false,
  }
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopRead: (() => void) | undefined
  const publish = (patch: Partial<HistoryState>) => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const createQuery = (text: string) =>
    createAsyncResource(
      `browser-history/${text}`,
      async signal => {
        // Allow a detached subscription to cancel before dispatching native I/O.
        await Promise.resolve()
        signal.throwIfAborted()
        return searchEmbeddedBrowserHistory(text)
      },
      {
        failure(error) {
          console.error('[Wework] Failed to load browsing history', error)
        },
      }
    )
  let query = createQuery('')
  const publishQuery = () => {
    const snapshot = query.getSnapshot()
    if (snapshot.status === 'loading') {
      generation += 1
      publish({ loading: true, loadingMore: false, paginationError: false, loadError: false })
    } else if (snapshot.status === 'ready' && snapshot.data) {
      publish({
        entries: snapshot.data,
        cursor: embeddedBrowserHistoryNextCursor(snapshot.data, snapshot.data.length),
        firstPageVersion: state.firstPageVersion + 1,
        loading: false,
        loadError: false,
      })
    } else if (snapshot.status === 'error') publish({ loading: false, loadError: true })
  }
  const commitSearch = () => {
    clearTimeout(timer)
    timer = undefined
    if (state.searchInput === state.query || !listeners.size) return
    stopRead?.()
    generation += 1
    query = createQuery(state.searchInput)
    publish({
      query: state.searchInput,
      entries: [],
      cursor: null,
      loading: true,
      loadError: false,
      loadingMore: false,
      paginationError: false,
    })
    stopRead = query.subscribe(publishQuery)
  }
  const scheduleSearch = () => {
    clearTimeout(timer)
    timer = undefined
    if (listeners.size && state.searchInput !== state.query) timer = setTimeout(commitSearch, 200)
  }
  const reload = () => {
    if (!listeners.size) return
    if (state.searchInput !== state.query) commitSearch()
    else void query.reload()
  }
  const mutate = async (kind: 'remove' | 'clear', ids: string[] = []) => {
    if (!listeners.size || state.removing || state.clearing || (kind === 'remove' && !ids.length))
      return false
    publish({ removing: kind === 'remove', clearing: kind === 'clear', actionFailed: false })
    try {
      if (kind === 'remove') await removeEmbeddedBrowserHistoryEntries(ids)
      else await clearEmbeddedBrowserData()
      if (!listeners.size) return false
      const removed = new Set(ids)
      publish({
        entries: kind === 'clear' ? [] : state.entries.filter(entry => !removed.has(entry.id)),
        cursor: null,
      })
      reload()
      return true
    } catch (error) {
      console.error('[Wework] Failed to modify browsing history', error)
      if (listeners.size) publish({ actionFailed: true })
      return false
    } finally {
      publish({ removing: false, clearing: false })
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        stopRead = query.subscribe(publishQuery)
        scheduleSearch()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          clearTimeout(timer)
          timer = undefined
          generation += 1
          publish({ loadingMore: false })
          stopRead?.()
          stopRead = undefined
        }
      }
    },
    changeSearch(value: string) {
      if (!listeners.size) return
      publish({ searchInput: value })
      scheduleSearch()
    },
    reload,
    async loadNextPage() {
      if (!listeners.size || !state.cursor || state.loading || state.loadingMore || state.loadError)
        return
      const current = generation
      const text = state.query,
        cursor = state.cursor
      publish({ loadingMore: true, paginationError: false })
      try {
        const page = await searchEmbeddedBrowserHistory(text, cursor)
        if (!listeners.size || current !== generation) return
        const entries = [...state.entries, ...page]
        publish({ entries, cursor: embeddedBrowserHistoryNextCursor(entries, page.length) })
      } catch (error) {
        if (listeners.size && current === generation) {
          console.error('[Wework] Failed to load more browsing history', error)
          publish({ paginationError: true })
        }
      } finally {
        if (listeners.size && current === generation) publish({ loadingMore: false })
      }
    },
    remove: (ids: string[]) => mutate('remove', [...new Set(ids)]),
    clear: () => mutate('clear'),
    clearNotice() {
      if (listeners.size) publish({ actionFailed: false })
    },
  }
}
