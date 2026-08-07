// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { codeWikiApi } from '@/apis/code-wiki'
import type { CodeWikiRunStatus } from '@/types/code-wiki'

/** How often to ask again while a run is going. */
const POLL_INTERVAL_MS = 5000

export interface RunStatusView {
  status: CodeWikiRunStatus | null
  /** Whether the regenerate action is available, and why not when it is not. */
  canRegenerate: boolean
  refresh: () => void
}

/**
 * What is being done to a wiki, kept current while something is.
 *
 * Polled rather than pushed: a run takes minutes, so the cost of asking every few
 * seconds is small next to a socket, and the answer is only needed while a reader is
 * looking at the page. Polling stops as soon as the run ends.
 *
 * A stale run counts as regenerable. The server reclaims it before starting the next
 * one, so the action succeeds — reporting the wiki as busy would leave the reader
 * waiting for a worker that is already gone.
 */
export function useCodeWikiRunStatus(knowledgeBaseId: number): RunStatusView {
  const [status, setStatus] = useState<CodeWikiRunStatus | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await codeWikiApi.status(knowledgeBaseId))
    } catch {
      // A status that cannot be read must not disable the button: the reader would
      // then be unable to act because of a failure unrelated to the wiki.
      setStatus(null)
    }
  }, [knowledgeBaseId])

  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      if (cancelled) return
      await load()
      if (cancelled) return
      timer.current = setTimeout(tick, POLL_INTERVAL_MS)
    }
    void tick()

    return () => {
      cancelled = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load])

  // Stop asking once nothing is happening. Kept as a separate effect so the polling
  // loop above does not need to know the answer it is about to receive.
  useEffect(() => {
    if (status && status.status !== 'running' && timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [status])

  return {
    status,
    canRegenerate: !status || status.status !== 'running' || status.is_stale,
    refresh: () => void load(),
  }
}
