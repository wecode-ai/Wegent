// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect } from 'react'

interface AsyncDataOptions<T, P = void> {
  /** Function to fetch data */
  fetchFn: (params: P) => Promise<T>
  /** Initial params for auto-fetch */
  params?: P
  /** Auto-fetch on mount (default: true) */
  autoFetch?: boolean
  /** Callback on success */
  onSuccess?: (data: T) => void
  /** Callback on error */
  onError?: (error: Error) => void
}

interface AsyncDataResult<T, P = void> {
  data: T | null
  loading: boolean
  error: Error | null
  execute: (params: P) => Promise<T | null>
  refresh: () => Promise<T | null>
  reset: () => void
}

/**
 * Hook for handling async data fetching with loading/error states
 */
export function useAsyncData<T, P = void>({
  fetchFn,
  params,
  autoFetch = true,
  onSuccess,
  onError,
}: AsyncDataOptions<T, P>): AsyncDataResult<T, P> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(autoFetch)
  const [error, setError] = useState<Error | null>(null)
  const [lastParams, setLastParams] = useState<P | undefined>(params)

  const execute = useCallback(
    async (execParams: P): Promise<T | null> => {
      setLoading(true)
      setError(null)
      setLastParams(execParams)
      try {
        const result = await fetchFn(execParams)
        setData(result)
        onSuccess?.(result)
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Failed to fetch data')
        setError(error)
        onError?.(error)
        return null
      } finally {
        setLoading(false)
      }
    },
    [fetchFn, onSuccess, onError]
  )

  const refresh = useCallback(async () => {
    if (lastParams !== undefined) {
      return execute(lastParams)
    }
    return null
  }, [execute, lastParams])

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (autoFetch && params !== undefined) {
      execute(params)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    data,
    loading,
    error,
    execute,
    refresh,
    reset,
  }
}
