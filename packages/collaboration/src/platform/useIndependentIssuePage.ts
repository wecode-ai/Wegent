import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useWindowEvent } from '../dom-events'
import type {
  IndependentIssuePage,
  PersonalIssueScope,
  PersonalIssueOrder,
  PersonalIssuesApi,
} from './personalIssuesApi'

export type IndependentIssuePageSource = {
  api?: Pick<PersonalIssuesApi, 'list'> | null
  userId: number
  revision: number
}

interface IssuePageSnapshot {
  page: IndependentIssuePage
  error: string | null
  loading: boolean
}

function createIssuePageStore(
  api: IndependentIssuePageSource['api'],
  scope: PersonalIssueScope,
  completed: boolean,
  archived: boolean,
  order: PersonalIssueOrder
) {
  let snapshot: IssuePageSnapshot = {
    page: { items: [], next_cursor: null },
    error: null,
    loading: Boolean(api),
  }
  const listeners = new Set<() => void>()
  let generation = 0
  let paging = false
  let contextRevision: number | undefined
  const publish = (next: IssuePageSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const request = async (more = false) => {
    if (
      !api ||
      !listeners.size ||
      (more && (paging || snapshot.loading || !snapshot.page.next_cursor))
    )
      return
    const current = more ? generation : ++generation
    if (more) paging = true
    else {
      paging = false
      publish({ ...snapshot, loading: true, error: null })
    }
    try {
      const next = await api.list(
        scope,
        completed,
        more ? snapshot.page.next_cursor! : undefined,
        archived,
        order
      )
      if (current !== generation || !listeners.size) return
      const page = more
        ? {
            items: [
              ...new Map(
                [...snapshot.page.items, ...next.items].map(issue => [issue.id, issue])
              ).values(),
            ],
            next_cursor: next.next_cursor,
          }
        : next
      publish({ page, loading: false, error: null })
    } catch (error) {
      if (current === generation && listeners.size)
        publish({
          ...snapshot,
          loading: false,
          error: String(error instanceof Error ? error.message : error),
        })
    } finally {
      if (current === generation) paging = false
    }
  }
  return {
    getSnapshot: () => snapshot,
    reload: () => {
      void request()
    },
    loadMore: () => request(true),
    subscribe(listener: () => void, revision: number | undefined) {
      listeners.add(listener)
      const refresh = listeners.size === 1 || contextRevision !== revision
      contextRevision = revision
      if (refresh) void request()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          generation++
          paging = false
        }
      }
    },
  }
}

export function useIndependentIssuePage(
  source: IndependentIssuePageSource | null,
  scope: PersonalIssueScope,
  completed: boolean,
  active: boolean,
  archived = false,
  order: PersonalIssueOrder = 'attention'
) {
  const api = source?.api
  const userId = source?.userId
  const revision = source?.revision
  const store = useMemo(
    () => ({ userId, ...createIssuePageStore(api, scope, completed, archived, order) }),
    [api, userId, scope, completed, archived, order]
  )
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener, revision),
    [store, revision]
  )
  const snapshot = useSyncExternalStore(
    active ? subscribe : subscribeIdleResource,
    store.getSnapshot,
    store.getSnapshot
  )
  useWindowEvent('focus', store.reload, { enabled: active && Boolean(api) })
  return {
    items: snapshot.page.items,
    loading: Boolean(api && active && snapshot.loading),
    error: snapshot.error,
    hasMore: Boolean(snapshot.page.next_cursor),
    loadMore: store.loadMore,
    reload: store.reload,
  }
}
