// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect } from 'react'

interface PaginationOptions<T> {
  /** Function to fetch data with pagination */
  fetchFn: (params: { page: number; limit: number }) => Promise<{ items: T[]; total: number }>
  /** Initial page number (default: 1) */
  initialPage?: number
  /** Items per page (default: 20) */
  limit?: number
  /** Auto-fetch on mount (default: true) */
  autoFetch?: boolean
}

interface PaginationResult<T> {
  items: T[]
  total: number
  page: number
  totalPages: number
  loading: boolean
  error: Error | null
  setPage: (page: number) => void
  refresh: () => Promise<void>
  hasNextPage: boolean
  hasPrevPage: boolean
}

/**
 * Hook for handling paginated data fetching in evaluation module
 */
export function useEvaluationPagination<T>({
  fetchFn,
  initialPage = 1,
  limit = 20,
  autoFetch = true,
}: PaginationOptions<T>): PaginationResult<T> {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(initialPage)
  const [loading, setLoading] = useState(autoFetch)
  const [error, setError] = useState<Error | null>(null)

  const totalPages = Math.ceil(total / limit)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchFn({ page, limit })
      setItems(result.items)
      setTotal(result.total)
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch data'))
    } finally {
      setLoading(false)
    }
  }, [fetchFn, page, limit])

  useEffect(() => {
    if (autoFetch) {
      fetchData()
    }
  }, [fetchData, autoFetch])

  return {
    items,
    total,
    page,
    totalPages,
    loading,
    error,
    setPage,
    refresh: fetchData,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  }
}
