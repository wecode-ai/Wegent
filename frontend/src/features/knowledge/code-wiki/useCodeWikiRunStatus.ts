// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { codeWikiApi } from '@/apis/code-wiki'
import type { CodeWikiRunStatus } from '@/types/code-wiki'

/** How often to ask again while a run is going. */
const POLL_INTERVAL_MS = 10_000

export interface RunStatusView {
  status: CodeWikiRunStatus | null
  /** Whether the regenerate action is available, and why not when it is not. */
  canRegenerate: boolean
  refresh: () => void
}

/**
 * What is being done to a wiki, kept current while something is.
 *
 * Polled rather than pushed: a run takes minutes, so the cost of asking every ten
 * seconds is small next to a socket, and the answer is only needed while a reader is
 * looking at the page. Polling stops as soon as the run ends.
 *
 * A stale run counts as regenerable. The server reclaims it before starting the next
 * one, so the action succeeds — reporting the wiki as busy would leave the reader
 * waiting for a worker that is already gone.
 */
export function useCodeWikiRunStatus(knowledgeBaseId: number): RunStatusView {
  const [status, setStatus] = useState<CodeWikiRunStatus | null>(null)

  const load = useCallback(async (): Promise<CodeWikiRunStatus | null> => {
    try {
      const next = await codeWikiApi.status(knowledgeBaseId)
      setStatus(next)
      return next
    } catch {
      // A status that cannot be read must not disable the button: the reader would
      // then be unable to act because of a failure unrelated to the wiki.
      // Keep an observed run active across a transient request failure as well. If
      // this poll replaced it with null, the state-driven timer would stop and one
      // network hiccup could leave the progress frozen until a page refresh.
      setStatus(current => (current?.status === 'running' ? current : null))
      return null
    }
  }, [knowledgeBaseId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (status?.status !== 'running') return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      timer = setTimeout(async () => {
        const next = await load()
        if (!cancelled && (!next || next.status === 'running')) schedule()
      }, POLL_INTERVAL_MS)
    }
    schedule()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [load, status?.generation_id, status?.status])

  return {
    status,
    canRegenerate: !status || status.status !== 'running' || status.is_stale,
    refresh: () => void load(),
  }
}
