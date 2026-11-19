import type {
  RuntimeWorkSearchItem,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
} from '@/types/api'
import type { WorkbenchCloudSearchResultsDetail } from '@/features/workbench/workbenchCloudDataEvents'
import { isPrimaryStandInConversation } from '@/lib/runtime-task-visibility'

const SEARCH_DEBOUNCE_MS = 180
const SEARCH_LIMIT = 20
const SEARCH_CACHE_LIMIT = 20
interface SearchSnapshot {
  query: string
  items: RuntimeWorkSearchItem[]
  selectedIndex: number
  loading: boolean
  failed: boolean
  searchedQuery: string
}
const INITIAL: SearchSnapshot = {
  query: '',
  items: [],
  selectedIndex: 0,
  loading: false,
  failed: false,
  searchedQuery: '',
}

/** One search surface owns its source-specific cache and accepts late cloud results by query. */
export function createWorkbenchSearchSession(
  search: (request: RuntimeWorkSearchRequest) => Promise<RuntimeWorkSearchResponse>
) {
  const cache = new Map<string, RuntimeWorkSearchItem[]>()
  const cloudResults = new Map<string, RuntimeWorkSearchItem[]>()
  const listeners = new Set<() => void>()
  let snapshot = INITIAL
  let query = ''
  let itemsQuery = ''
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = (patch: Partial<SearchSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const cancel = () => {
    revision++
    clearTimeout(timer)
    timer = undefined
  }
  const read = (nextQuery: string) => {
    cancel()
    query = nextQuery
    if (!query) {
      itemsQuery = ''
      publish({ ...INITIAL })
      return
    }
    if (cache.has(query)) {
      itemsQuery = query
      publish({
        query,
        items: cache.get(query)!,
        selectedIndex: 0,
        failed: false,
        loading: false,
        searchedQuery: query,
      })
      return
    }
    publish({ query, loading: false, failed: false, searchedQuery: '' })
    const version = revision
    const requestedQuery = query
    timer = setTimeout(async () => {
      timer = undefined
      const current = () => version === revision && listeners.size > 0
      publish({ loading: true })
      try {
        const response = await search({ query: requestedQuery, limit: SEARCH_LIMIT })
        if (!current()) return
        const items = mergeSearchItems(
          response.items,
          cloudResults.get(requestedQuery) ?? [],
          SEARCH_LIMIT
        )
        rememberSearchResults(cache, requestedQuery, items)
        itemsQuery = requestedQuery
        publish({
          items,
          selectedIndex: 0,
          loading: false,
          failed: false,
          searchedQuery: requestedQuery,
        })
      } catch {
        if (current())
          publish({ items: [], loading: false, failed: true, searchedQuery: requestedQuery })
      }
    }, SEARCH_DEBOUNCE_MS)
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL,
    subscribe(listener: () => void, nextQuery: string) {
      listeners.add(listener)
      if (listeners.size === 1) read(nextQuery)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) cancel()
      }
    },
    select(update: number | ((current: number) => number)) {
      publish({
        selectedIndex: typeof update === 'function' ? update(snapshot.selectedIndex) : update,
      })
    },
    acceptCloud(detail: WorkbenchCloudSearchResultsDetail | undefined) {
      const resultQuery = detail?.request.query.trim()
      if (!resultQuery || !detail) return
      cloudResults.set(resultQuery, detail.response.items)
      if (resultQuery !== query || !listeners.size) return
      const items = mergeSearchItems(
        itemsQuery === query ? snapshot.items : [],
        detail.response.items,
        SEARCH_LIMIT
      )
      rememberSearchResults(cache, resultQuery, items)
      itemsQuery = resultQuery
      publish({ items })
    },
  }
}

function rememberSearchResults(
  cache: Map<string, RuntimeWorkSearchItem[]>,
  query: string,
  items: RuntimeWorkSearchItem[]
) {
  if (cache.has(query)) {
    cache.delete(query)
  }
  cache.set(query, items)
  if (cache.size <= SEARCH_CACHE_LIMIT) return
  const oldestKey = cache.keys().next().value
  if (oldestKey) {
    cache.delete(oldestKey)
  }
}

function mergeSearchItems(
  primary: RuntimeWorkSearchItem[],
  secondary: RuntimeWorkSearchItem[],
  limit: number
): RuntimeWorkSearchItem[] {
  const merged = new Map<string, RuntimeWorkSearchItem>()
  const candidates = [...primary, ...secondary]
  candidates.forEach(item => {
    if (isPrimaryStandInConversation(item.address)) return
    const key = [
      item.address.deviceId,
      item.address.taskId,
      item.address.workspacePath ?? '',
      item.messageId ?? '',
    ].join('\0')
    merged.set(key, item)
  })
  return [...merged.values()]
    .sort((left, right) => searchUpdatedAt(right) - searchUpdatedAt(left))
    .slice(0, limit)
}

function searchUpdatedAt(item: RuntimeWorkSearchItem): number {
  if (!item.updatedAt) return 0
  const timestamp = new Date(item.updatedAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}
