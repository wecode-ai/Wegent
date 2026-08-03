// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'

import type { CollectorRunInfo } from '../api'
import { fetchCollectorRuns } from '../api'

export function useCollectorRuns() {
  const [data, setData] = useState<CollectorRunInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async (runId: number) => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetchCollectorRuns(runId)
      setData(res.collectors)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    setData([])
    setLoading(false)
    setError(null)
  }, [])

  return { collectors: data, loading, error, load, reset }
}
