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
    // Abort the in-flight request on filter/name/scope change or unmount.
    const controller = new AbortController()
    setLoading(true)
    fetchMetric(scope, name, filter, controller.signal)
      .then(d => setData(d))
      .catch(e => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(e)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, name, filterKey, enabled])

  return { data, loading, error }
}
