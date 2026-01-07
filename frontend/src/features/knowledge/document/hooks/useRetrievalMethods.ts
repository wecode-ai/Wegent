// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'
import { retrieverApis, type RetrievalMethodType } from '@/apis/retrievers'

export function useRetrievalMethods() {
  const [methods, setMethods] = useState<Record<string, RetrievalMethodType[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const fetchMethods = async () => {
      try {
        setLoading(true)
        const response = await retrieverApis.getStorageRetrievalMethods()
        setMethods(response.data || {})
      } catch (err) {
        setError(err as Error)
      } finally {
        setLoading(false)
      }
    }

    fetchMethods()
  }, [])

  return { methods, loading, error }
}
