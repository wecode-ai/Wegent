// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { fetchMetricList, type MetricListResponse, type StatScope } from '../api'

export function useMetricList(scope: StatScope) {
  const [data, setData] = useState<MetricListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    // Abort the in-flight request on scope change or unmount.
    const controller = new AbortController()
    setLoading(true)
    fetchMetricList(scope, controller.signal)
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
  }, [JSON.stringify(scope)])

  return { data, loading, error }
}
