'use client'

import { useState, useCallback } from 'react'

interface UseFetchOptions<T> {
  onSuccess?: (data: T) => void
  onError?: (error: Error) => void
}

export function useFetch<T>() {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const execute = useCallback(
    async (
      fetchFn: () => Promise<T>,
      options?: UseFetchOptions<T>
    ): Promise<T | null> => {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchFn()
        setData(result)
        options?.onSuccess?.(result)
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        setError(error)
        options?.onError?.(error)
        return null
      } finally {
        setLoading(false)
      }
    },
    []
  )

  return { data, loading, error, execute, setData }
}

export function useApiCall<T, P extends unknown[]>(
  apiFn: (...args: P) => Promise<T>
) {
  const { data, loading, error, execute, setData } = useFetch<T>()

  const call = useCallback(
    async (...args: P) => {
      return execute(() => apiFn(...args))
    },
    [apiFn, execute]
  )

  return { data, loading, error, call, setData }
}
