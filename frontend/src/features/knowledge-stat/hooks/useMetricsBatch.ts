// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import {
  type MetricFilter,
  type MetricsBatchResponse,
  type StatScope,
  fetchMetricsBatch,
} from '../api'

/**
 * Fetch many metrics in a single batch request.
 *
 * `namesKey` is a stable string (joined names) used as the effect dependency
 * so changing the array identity does not refetch. Returns a name->response
 * map that callers index per card, plus an aggregate loading/error state.
 */
export function useMetricsBatch(scope: StatScope, names: string[], filter: MetricFilter) {
  const [data, setData] = useState<MetricsBatchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Stable key: names order is deterministic (derived from the metric list),
  // so a sorted join avoids refetch churn when the parent re-renders.
  const namesKey = names.slice().sort().join(',')
  const filterKey = JSON.stringify(filter)
  const scopeKey = JSON.stringify(scope)

  useEffect(() => {
    let cancelled = false
    if (names.length === 0) {
      setData({ results: {} })
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    fetchMetricsBatch(scope, names, filter)
      .then(d => !cancelled && setData(d))
      .catch(e => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, namesKey, filterKey])

  return { data, loading, error }
}
