import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  IndependentIssuePage,
  PersonalIssueScope,
  PersonalIssueOrder,
} from '@/api/personalIssues'
import { useIndependentIssues } from './independentIssuesContext'

export function useIndependentIssuePage(
  scope: PersonalIssueScope,
  completed: boolean,
  active: boolean,
  archived = false,
  order: PersonalIssueOrder = 'attention'
) {
  const context = useIndependentIssues()
  const api = context?.api
  const [retry, setRetry] = useState(0)
  const [snapshot, setSnapshot] = useState<{
    key: string
    scopeKey: string
    page: IndependentIssuePage
    error: string | null
    loading: boolean
  }>()
  const generation = useRef(0)
  const paging = useRef(false)
  const scopeKey = JSON.stringify([context?.userId, scope, completed, archived, order])
  const key = JSON.stringify([scopeKey, context?.revision, retry])
  const reload = useCallback(() => setRetry(value => value + 1), [])
  useEffect(() => {
    const current = ++generation.current
    paging.current = false
    if (!api || !active) return
    void api.list(scope, completed, undefined, archived, order).then(
      page => {
        if (generation.current === current)
          setSnapshot({ key, scopeKey, page, loading: false, error: null })
      },
      error => {
        if (generation.current === current)
          setSnapshot(previous => ({
            key,
            scopeKey,
            page:
              previous?.scopeKey === scopeKey ? previous.page : { items: [], next_cursor: null },
            loading: false,
            error: String(error instanceof Error ? error.message : error),
          }))
      }
    )
    window.addEventListener('focus', reload)
    return () => {
      generation.current = current + 1
      window.removeEventListener('focus', reload)
    }
  }, [api, active, key, scopeKey, scope, completed, archived, order, reload])
  const loadMore = async () => {
    if (!api || !active || !snapshot?.page.next_cursor || snapshot.key !== key || paging.current)
      return
    paging.current = true
    const current = generation.current
    try {
      const next = await api.list(scope, completed, snapshot.page.next_cursor, archived, order)
      if (generation.current === current)
        setSnapshot(previous =>
          previous?.key === key
            ? {
                ...previous,
                error: null,
                page: {
                  items: [
                    ...new Map(
                      [...previous.page.items, ...next.items].map(issue => [issue.id, issue])
                    ).values(),
                  ],
                  next_cursor: next.next_cursor,
                },
              }
            : previous
        )
    } catch (error) {
      if (generation.current === current)
        setSnapshot(previous =>
          previous?.key === key
            ? { ...previous, error: String(error instanceof Error ? error.message : error) }
            : previous
        )
    } finally {
      if (generation.current === current) paging.current = false
    }
  }
  const current = snapshot?.scopeKey === scopeKey ? snapshot : undefined
  return {
    items: current?.page.items ?? [],
    loading: Boolean(api && active && (!current || current.loading || current.key !== key)),
    error: current?.key === key ? current.error : undefined,
    hasMore: Boolean(current?.page.next_cursor),
    loadMore,
    reload,
    context,
  }
}
