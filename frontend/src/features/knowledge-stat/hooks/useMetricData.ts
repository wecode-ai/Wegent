// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { type MetricResponse, type MetricFilter, type StatScope, fetchMetric } from '../api'

/**
 * Fetch a single metric.
 *
 * `enabled` (default true) gates the network request so callers that already
 * hold the data via a batch request can render this hook (hooks rules
 * forbid conditional calls) without firing a redundant per-card fetch.
 */
export function useMetricData(
  scope: StatScope,
  name: string,
  filter: MetricFilter,
  enabled = true
) {
  const [data, setData] = useState<MetricResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Stable string keys so array/object identity churn does not refetch.
  const scopeKey = JSON.stringify(scope)
  const filterKey = JSON.stringify(filter)

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    setLoading(true)
    fetchMetric(scope, name, filter)
      .then(d => !cancelled && setData(d))
      .catch(e => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, name, filterKey, enabled])

  return { data, loading, error }
}
