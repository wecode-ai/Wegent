import { useCallback, useEffect, useRef, useState } from 'react'
import type { SharedWorkspaceApi, WorkspaceMyWorkItem } from '@wegent/collaboration'
import {
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
} from './projectSpaceSelection'

type SourceSnapshot = {
  api: SharedWorkspaceApi
  items: WorkspaceMyWorkItem[]
  nextCursor: string | null
  loading: boolean
  error: boolean
  queryKey: string
}

/** Each store publishes one bounded page independently; cards never fetch their own context. */
export function usePersonalHomeIssues(
  sources: SharedWorkspaceApi[],
  active: boolean,
  assignedOnly: boolean,
  includeCompleted: boolean,
  viewerIds: readonly (string | number)[]
) {
  const [snapshots, setSnapshots] = useState<SourceSnapshot[]>([])
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const pendingPages = useRef(new Set<SharedWorkspaceApi>())
  const viewers = JSON.stringify(viewerIds)
  const queryKey = JSON.stringify([revision, assignedOnly, includeCompleted, viewers])
  const reload = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    const requestGeneration = ++generation.current
    pendingPages.current.clear()
    if (!active) return
    const input = {
      limit: 30,
      order: 'attention' as const,
      scope: assignedOnly ? ('assigned' as const) : ('participating' as const),
      includeCompleted,
      viewerIds: JSON.parse(viewers) as (string | number)[],
    }
    for (const api of sources) {
      void Promise.resolve()
        .then(() => {
          if (!api.myWork?.page) throw new Error('Paged My work is unavailable')
          return api.myWork.page(input)
        })
        .then(
          page => {
            if (generation.current === requestGeneration)
              setSnapshots(previous => [
                ...previous.filter(
                  snapshot => sources.includes(snapshot.api) && snapshot.api !== api
                ),
                {
                  api,
                  queryKey,
                  items: page.items,
                  nextCursor: page.nextCursor,
                  loading: false,
                  error: false,
                },
              ])
          },
          () => {
            if (generation.current === requestGeneration)
              setSnapshots(previous => [
                ...previous.filter(
                  snapshot => sources.includes(snapshot.api) && snapshot.api !== api
                ),
                {
                  api,
                  queryKey,
                  items: previous.find(snapshot => snapshot.api === api)?.items ?? [],
                  nextCursor: null,
                  loading: false,
                  error: true,
                },
              ])
          }
        )
    }
    const unsubscribeBinding = subscribeProjectSpaceTaskBindingChanged(reload)
    const unsubscribeContext = subscribeProjectSpaceTaskContextChanged(reload)
    window.addEventListener('focus', reload)
    return () => {
      generation.current += 1
      unsubscribeBinding()
      unsubscribeContext()
      window.removeEventListener('focus', reload)
    }
  }, [sources, queryKey, active, assignedOnly, includeCompleted, viewers, reload])
  const current = sources.map(api => {
    const snapshot = snapshots.find(snapshot => snapshot.api === api)
    return snapshot
      ? {
          ...snapshot,
          loading: active && (snapshot.loading || snapshot.queryKey !== queryKey),
          error: snapshot.queryKey === queryKey && snapshot.error,
        }
      : { api, queryKey, items: [], nextCursor: null, loading: active, error: false }
  })
  const loadMore = async () => {
    if (!active) return
    const requestGeneration = generation.current
    await Promise.all(
      current
        .filter(
          snapshot =>
            snapshot.nextCursor && !snapshot.loading && !pendingPages.current.has(snapshot.api)
        )
        .map(async snapshot => {
          pendingPages.current.add(snapshot.api)
          setSnapshots(previous =>
            previous.map(row =>
              row.api === snapshot.api ? { ...row, loading: true, error: false } : row
            )
          )
          try {
            const page = await snapshot.api.myWork!.page!({
              cursor: snapshot.nextCursor!,
              limit: 30,
              order: 'attention',
              scope: assignedOnly ? 'assigned' : 'participating',
              includeCompleted,
              viewerIds,
            })
            if (generation.current === requestGeneration)
              setSnapshots(previous =>
                previous.map(row =>
                  row.api === snapshot.api
                    ? {
                        ...row,
                        items: [
                          ...new Map(
                            [...row.items, ...page.items].map(item => [item.id, item])
                          ).values(),
                        ],
                        nextCursor: page.nextCursor,
                        loading: false,
                        error: false,
                      }
                    : row
                )
              )
          } catch {
            if (generation.current === requestGeneration)
              setSnapshots(previous =>
                previous.map(row =>
                  row.api === snapshot.api ? { ...row, loading: false, error: true } : row
                )
              )
          } finally {
            if (generation.current === requestGeneration) pendingPages.current.delete(snapshot.api)
          }
        })
    )
  }
  return {
    items: current.flatMap(snapshot => snapshot.items),
    loading: current.some(snapshot => snapshot.loading),
    error: current.some(snapshot => snapshot.error),
    hasMore: current.some(snapshot => snapshot.nextCursor !== null),
    reload,
    loadMore,
    replaceIssue: (updated: WorkspaceMyWorkItem) =>
      setSnapshots(previous =>
        previous.map(snapshot => ({
          ...snapshot,
          items: snapshot.items.map(item =>
            item.id === updated.id && item.cloud_project_id === updated.cloud_project_id
              ? { ...item, ...updated }
              : item
          ),
        }))
      ),
  }
}
