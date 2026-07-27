// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { formatLocalDate, inclusiveDateCount } from '../date-utils'

export interface StatFilterState {
  startDate: string
  endDate: string
  kbIds?: number[]
}

function getDefaultFilter(): StatFilterState {
  const now = new Date()
  const end = new Date(now)
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(start.getDate() - 6)

  return {
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(end),
  }
}

export function useStatFilter(initial?: Partial<StatFilterState>) {
  const [filter, setFilter] = useState<StatFilterState>({
    ...getDefaultFilter(),
    ...initial,
  })

  const setStartDate = useCallback((date: string) => {
    setFilter(prev => ({ ...prev, startDate: date }))
  }, [])

  const setEndDate = useCallback((date: string) => {
    setFilter(prev => ({ ...prev, endDate: date }))
  }, [])

  const setKbIds = useCallback((kbIds: number[]) => {
    setFilter(prev => ({ ...prev, kbIds: kbIds.length > 0 ? kbIds : undefined }))
  }, [])

  // Derived: the lookback window in days (inclusive). Used by MetricCard
  // to show a "based on N-day sliding window" badge on time-series charts.
  const lookbackDays = (() => {
    return Math.max(inclusiveDateCount(filter.startDate, filter.endDate), 1)
  })()

  return { filter, setFilter, setStartDate, setEndDate, setKbIds, lookbackDays }
}
