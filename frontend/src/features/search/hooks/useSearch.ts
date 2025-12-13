// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import searchApis, { SearchResponse, SearchParams } from '@/apis/search'
import { SearchState, SearchType, SortType, DateRangeType } from '../types'

function getDateFromRange(range: DateRangeType): { from?: string; to?: string } {
  const now = new Date()
  const to = now.toISOString()

  switch (range) {
    case '1d':
      return {
        from: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        to,
      }
    case '7d':
      return {
        from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        to,
      }
    case '30d':
      return {
        from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        to,
      }
    case 'custom':
    case 'all':
    default:
      return {}
  }
}

export function useSearch() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Parse URL params to initial state
  const [state, setState] = useState<SearchState>(() => {
    const query = searchParams.get('q') || ''
    const typesParam = searchParams.get('type')
    const types = typesParam
      ? (typesParam.split(',').filter(Boolean) as SearchType[])
      : []
    const sort = (searchParams.get('sort') as SortType) || 'relevance'
    const dateRange = (searchParams.get('date') as DateRangeType) || 'all'
    const dateFrom = searchParams.get('from') || undefined
    const dateTo = searchParams.get('to') || undefined
    const page = parseInt(searchParams.get('page') || '1', 10)

    return { query, types, sort, dateRange, dateFrom, dateTo, page }
  })

  const [results, setResults] = useState<SearchResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Update URL when state changes
  const updateUrl = useCallback(
    (newState: SearchState) => {
      const params = new URLSearchParams()

      if (newState.query) {
        params.set('q', newState.query)
      }
      if (newState.types.length > 0) {
        params.set('type', newState.types.join(','))
      }
      if (newState.sort !== 'relevance') {
        params.set('sort', newState.sort)
      }
      if (newState.dateRange !== 'all') {
        params.set('date', newState.dateRange)
      }
      if (newState.dateRange === 'custom') {
        if (newState.dateFrom) params.set('from', newState.dateFrom)
        if (newState.dateTo) params.set('to', newState.dateTo)
      }
      if (newState.page > 1) {
        params.set('page', newState.page.toString())
      }

      const queryString = params.toString()
      router.replace(`/search${queryString ? `?${queryString}` : ''}`)
    },
    [router]
  )

  // Perform search
  const performSearch = useCallback(async (searchState: SearchState) => {
    if (!searchState.query.trim()) {
      setResults(null)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const dates = searchState.dateRange === 'custom'
        ? { from: searchState.dateFrom, to: searchState.dateTo }
        : getDateFromRange(searchState.dateRange)

      const params: SearchParams = {
        q: searchState.query,
        types: searchState.types.length > 0 ? searchState.types : undefined,
        sort: searchState.sort,
        date_from: dates.from,
        date_to: dates.to,
        page: searchState.page,
        limit: 20,
      }

      const response = await searchApis.search(params)
      setResults(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setResults(null)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Search when state changes
  useEffect(() => {
    if (state.query) {
      performSearch(state)
    }
  }, [state, performSearch])

  // Update query
  const setQuery = useCallback(
    (query: string) => {
      const newState = { ...state, query, page: 1 }
      setState(newState)
      updateUrl(newState)
    },
    [state, updateUrl]
  )

  // Update types filter
  const setTypes = useCallback(
    (types: SearchType[]) => {
      const newState = { ...state, types, page: 1 }
      setState(newState)
      updateUrl(newState)
    },
    [state, updateUrl]
  )

  // Update sort
  const setSort = useCallback(
    (sort: SortType) => {
      const newState = { ...state, sort, page: 1 }
      setState(newState)
      updateUrl(newState)
    },
    [state, updateUrl]
  )

  // Update date range
  const setDateRange = useCallback(
    (dateRange: DateRangeType, dateFrom?: string, dateTo?: string) => {
      const newState = { ...state, dateRange, dateFrom, dateTo, page: 1 }
      setState(newState)
      updateUrl(newState)
    },
    [state, updateUrl]
  )

  // Update page
  const setPage = useCallback(
    (page: number) => {
      const newState = { ...state, page }
      setState(newState)
      updateUrl(newState)
    },
    [state, updateUrl]
  )

  // Clear all filters
  const clearFilters = useCallback(() => {
    const newState: SearchState = {
      query: state.query,
      types: [],
      sort: 'relevance',
      dateRange: 'all',
      page: 1,
    }
    setState(newState)
    updateUrl(newState)
  }, [state.query, updateUrl])

  return {
    // State
    query: state.query,
    types: state.types,
    sort: state.sort,
    dateRange: state.dateRange,
    dateFrom: state.dateFrom,
    dateTo: state.dateTo,
    page: state.page,

    // Results
    results,
    isLoading,
    error,

    // Actions
    setQuery,
    setTypes,
    setSort,
    setDateRange,
    setPage,
    clearFilters,
    refresh: () => performSearch(state),
  }
}
