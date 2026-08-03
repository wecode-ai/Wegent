// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

import type { RunInfo } from '../api'
import { fetchRuns } from '../api'

const PAGE_SIZE = 20
const POLL_INTERVAL = 10_000

export function useRuns() {
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Monotonic request id: every load() bumps it, and a response is applied
  // only if its id still matches the latest. This prevents a slow in-flight
  // request (e.g. the 10s poll) from overwriting a newer manual refresh —
  // the "refresh sometimes doesn't update the list" symptom.
  const reqIdRef = useRef(0)
  // Latest page kept in a ref so the manual-refresh handler always reloads
  // the page the user is actually on, even if the `refresh` callback is a
  // stale closure when the custom event fires.
  const pageRef = useRef(1)

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const load = useCallback(async (p: number, isPoll = false) => {
    const myId = ++reqIdRef.current
    try {
      // Only the initial / user-initiated load flips `loading` (which
      // disables pagination controls). Background polling uses a separate
      // `polling` flag so the 10s refresh does not freeze the UI every cycle.
      if (isPoll) setPolling(true)
      else setLoading(true)
      setError(null)
      const offset = (p - 1) * PAGE_SIZE
      const res = await fetchRuns({ limit: PAGE_SIZE, offset })
      // Discard stale responses — a newer load() has superseded this one.
      if (myId !== reqIdRef.current) return
      setRuns(res.runs)
      setTotal(res.total)
    } catch (e) {
      if (myId !== reqIdRef.current) return
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      if (myId === reqIdRef.current) {
        setLoading(false)
        setPolling(false)
      }
    }
  }, [])

  const goToPage = useCallback(
    (p: number) => {
      const clamped = Math.max(1, Math.min(p, totalPages))
      setPage(clamped)
      pageRef.current = clamped
      load(clamped)
    },
    [totalPages, load]
  )

  const refresh = useCallback(() => {
    // Always reload the latest page, not whatever page the closure captured.
    // Mark as a poll so it does not toggle the pagination-disabling `loading`.
    load(pageRef.current, true)
  }, [load])

  const hasRunning = runs.some(r => r.status === 'running')

  useEffect(() => {
    load(1)
  }, [load])

  useEffect(() => {
    if (hasRunning) {
      pollRef.current = setInterval(refresh, POLL_INTERVAL)
    } else if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [hasRunning, refresh])

  return { runs, total, page, totalPages, loading, polling, error, goToPage, refresh }
}
