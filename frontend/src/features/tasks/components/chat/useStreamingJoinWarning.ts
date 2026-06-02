// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react'
import type { StreamingInfo } from '../../state'
import { getStreamingJoinWarningKey } from './streamingJoinWarning'

interface UseStreamingJoinWarningOptions {
  taskId?: number | null
  status?: string
  streamingInfo?: StreamingInfo | null
  translate: (key: string) => string
  notify: (title: string) => void
}

export function useStreamingJoinWarning({
  taskId,
  status,
  streamingInfo,
  translate,
  notify,
}: UseStreamingJoinWarningOptions) {
  const lastWarningRef = useRef<string | null>(null)

  useEffect(() => {
    if (!streamingInfo || status !== 'streaming') {
      lastWarningRef.current = null
      return
    }

    const warningKey = getStreamingJoinWarningKey({
      started_at: streamingInfo.started_at,
      last_activity_at: streamingInfo.last_activity_at,
    })
    if (!warningKey) return

    const dedupeKey = `${taskId || 0}:${warningKey}`
    if (lastWarningRef.current === dedupeKey) return

    lastWarningRef.current = dedupeKey
    notify(translate(warningKey))
  }, [notify, status, streamingInfo, taskId, translate])
}
