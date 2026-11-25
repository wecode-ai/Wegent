import type { SharedWorkspaceApi, WorkspaceMyWorkItem } from '../ports/SharedWorkspaceApi'

export type PersonalHomeIssueSource = {
  myWork?: Pick<NonNullable<SharedWorkspaceApi['myWork']>, 'page'>
}

export type SubscribePersonalIssueChanges = (reload: () => void) => () => void

export interface PersonalHomeCreationNotice {
  key: string
  onHandled?(key: string): void
}

export type PersonalHomeIssueOrder = 'attention' | 'activity' | 'assignment' | 'priority'
interface Query {
  scope: 'assigned' | 'created' | 'participating'
  order: PersonalHomeIssueOrder
  includeCompleted: boolean
  viewerIds: (string | number)[]
}
interface Row<Source> {
  queryKey: string
  scopeKey: string
  api: Source
  items: WorkspaceMyWorkItem[]
  nextCursor: string | null
  loading: boolean
  error: boolean
}
interface Snapshot<Source> {
  rows: Row<Source>[]
  revision: number
}

/** Each authority owns a bounded page; one source failing never blocks another. */
export function createPersonalHomeIssuesSource<Source extends PersonalHomeIssueSource>(
  sourceApis: Source[],
  query: Query,
  initial?: Snapshot<Source>,
  subscribeChanges?: SubscribePersonalIssueChanges
) {
  const apis = [...sourceApis]
  const scopeKey = JSON.stringify([
    query.scope,
    query.includeCompleted,
    JSON.stringify(query.viewerIds),
    query.order,
  ])
  const queryKey = (revision: number) => JSON.stringify([revision, scopeKey])
  let detach: (() => void) | undefined
  let snapshot: Snapshot<Source> = {
    rows: apis.map(
      api =>
        initial?.rows.find(row => row.api === api && row.scopeKey === scopeKey) ?? {
          scopeKey,
          queryKey: queryKey(initial?.revision ?? 0),
          api,
          items: [],
          nextCursor: null,
          loading: true,
          error: false,
        }
    ),
    revision: initial?.revision ?? 0,
  }
  let generation = 0
  const pendingPages = new Set<Source>()
  const listeners = new Map<() => void, boolean>()
  const consumedCreations = new Set<string>()
  const hasActiveReaders = () => [...listeners.values()].some(active => active)
  const publish = () => {
    for (const listener of listeners.keys()) listener()
  }
  const update = (api: Source, change: (row: Row<Source>) => Row<Source>) => {
    snapshot = {
      ...snapshot,
      rows: snapshot.rows.map(row => (row.api === api ? change(row) : row)),
    }
    publish()
  }
  const current = (epoch: number) => hasActiveReaders() && generation === epoch
  const readFirstPages = async () => {
    if (!hasActiveReaders()) return
    const epoch = ++generation
    pendingPages.clear()
    snapshot = {
      ...snapshot,
      rows: snapshot.rows.map(row => ({
        ...row,
        queryKey: queryKey(snapshot.revision),
        scopeKey,
        loading: true,
        error: false,
      })),
    }
    publish()
    await Promise.all(
      apis.map(async api => {
        try {
          await Promise.resolve()
          if (!current(epoch)) return
          if (!api.myWork?.page) throw new Error('Paged My work is unavailable')
          const page = await api.myWork.page({ ...query, limit: 30 })
          if (current(epoch))
            update(api, row => ({
              ...row,
              items: page.items,
              nextCursor: page.nextCursor,
              loading: false,
              error: false,
            }))
        } catch {
          if (current(epoch))
            update(api, row => ({ ...row, nextCursor: null, loading: false, error: true }))
        }
      })
    )
  }
  const reload = () => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1 }
    void readFirstPages()
  }
  const loadMore = async () => {
    if (!hasActiveReaders()) return
    const epoch = generation
    await Promise.all(
      snapshot.rows
        .filter(row => row.nextCursor && !row.loading && !pendingPages.has(row.api))
        .map(async row => {
          const api = row.api
          pendingPages.add(api)
          update(api, current => ({ ...current, loading: true, error: false }))
          try {
            if (!api.myWork?.page) throw new Error('Paged My work is unavailable')
            const page = await api.myWork.page({ ...query, cursor: row.nextCursor!, limit: 30 })
            if (current(epoch))
              update(api, current => ({
                ...current,
                items: [
                  ...new Map(
                    [...current.items, ...page.items].map(item => [item.id, item])
                  ).values(),
                ],
                nextCursor: page.nextCursor,
                loading: false,
                error: false,
              }))
          } catch {
            if (current(epoch))
              update(api, current => ({ ...current, loading: false, error: true }))
          } finally {
            if (current(epoch)) pendingPages.delete(api)
          }
        })
    )
  }
  return {
    getSnapshot: () => snapshot,
    reload,
    loadMore,
    replaceIssue(updated: WorkspaceMyWorkItem) {
      snapshot = {
        ...snapshot,
        rows: snapshot.rows.map(row => ({
          ...row,
          items: row.items.map(item =>
            item.id === updated.id && item.cloud_project_id === updated.cloud_project_id
              ? { ...item, ...updated }
              : item
          ),
        })),
      }
      publish()
    },
    subscribe(listener: () => void, active = true, creation?: PersonalHomeCreationNotice) {
      const wasActive = hasActiveReaders()
      listeners.set(listener, active)
      const created = creation && !consumedCreations.has(creation.key)
      if (created) {
        consumedCreations.add(creation.key)
        snapshot = { ...snapshot, revision: snapshot.revision + 1 }
      }
      if (active && !wasActive) {
        const stopChanges = subscribeChanges?.(reload)
        window.addEventListener('focus', reload)
        detach = () => {
          stopChanges?.()
          window.removeEventListener('focus', reload)
        }
        void readFirstPages()
      } else if (created && hasActiveReaders()) {
        void readFirstPages()
      }
      if (created && listeners.has(listener)) creation.onHandled?.(creation.key)
      return () => {
        listeners.delete(listener)
        if (!hasActiveReaders()) {
          generation += 1
          pendingPages.clear()
          detach?.()
          detach = undefined
        }
      }
    },
  }
}
