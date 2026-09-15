// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { fetchManagedTeamsPage, type ManagedTeamsNextPage } from '../services/teams'
import type { Team } from '@/types/api'

type PageOptions = Parameters<typeof fetchManagedTeamsPage>[0]
interface Options extends Omit<PageOptions, 'cursor' | 'page'> {
  userId?: number
  enabled?: boolean
}

interface Catalog {
  key: string
  items: Team[]
  next: ManagedTeamsNextPage | null
}

function mergeTeams(current: Team[], incoming: Team[]): Team[] {
  return [...new Map([...current, ...incoming].map(team => [team.id, team])).values()]
}

/** Keep one browsing snapshot; search results never mark the whole catalog complete. */
export function useManagedTeams({ userId, enabled = true, keyword, ...options }: Options) {
  const serializedParams = JSON.stringify(options)
  const params = useMemo(
    () => JSON.parse(serializedParams) as Omit<PageOptions, 'keyword'>,
    [serializedParams]
  )
  const key = JSON.stringify([userId, params])
  const query = keyword.trim()
  const catalog = useRef<Catalog | null>(null)
  const controller = useRef<AbortController | null>(null)
  const loadingMore = useRef(false)
  const [teams, updateTeams] = useState<Team[]>([])
  const [next, setNext] = useState<ManagedTeamsNextPage | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(
    async (nextPage?: ManagedTeamsNextPage, refresh = false) => {
      if (nextPage && loadingMore.current) return
      if (!nextPage) {
        controller.current?.abort()
        controller.current = new AbortController()
        loadingMore.current = false
        setIsLoadingMore(false)
        setError(null)
        if (refresh) catalog.current = null
        if (!enabled || userId === undefined) {
          updateTeams([])
          setNext(null)
          setIsLoading(false)
          return
        }
        const saved = catalog.current
        if (saved?.key === key && (!query || !saved.next)) {
          updateTeams(saved.items)
          setNext(query ? null : saved.next)
          setIsLoading(false)
          return
        }
        setIsLoading(true)
      } else {
        loadingMore.current = true
        setIsLoadingMore(true)
        setError(null)
      }
      const request = controller.current!
      try {
        const page =
          params.groupNames?.length === 0
            ? { items: [], next: null }
            : await fetchManagedTeamsPage(
                { ...params, keyword: query, ...nextPage },
                request.signal
              )
        if (request.signal.aborted) return
        updateTeams(current => {
          const items = nextPage ? mergeTeams(current, page.items) : page.items
          if (!query) catalog.current = { key, items, next: page.next }
          return items
        })
        setNext(page.next)
      } catch (cause) {
        if (request.signal.aborted) return
        if (!nextPage) {
          updateTeams([])
          setNext(null)
        }
        setError(cause instanceof Error ? cause : new Error('Failed to load agents'))
      } finally {
        if (!request.signal.aborted) {
          loadingMore.current = false
          setIsLoadingMore(false)
          setIsLoading(false)
        }
      }
    },
    [enabled, userId, key, params, query]
  )

  useEffect(() => {
    void load()
    return () => controller.current?.abort()
  }, [load])

  const setTeams = useCallback((update: SetStateAction<Team[]>) => {
    catalog.current = null
    updateTeams(update)
  }, [])
  const refresh = useCallback(() => load(undefined, true), [load])
  const loadMore = useCallback(() => (next ? load(next) : Promise.resolve()), [next, load])
  const retry = useCallback(() => (next ? load(next) : load(undefined, true)), [next, load])

  return {
    teams,
    setTeams,
    isLoading,
    isLoadingMore,
    error,
    hasMore: Boolean(next),
    refresh,
    loadMore,
    retry,
  }
}
