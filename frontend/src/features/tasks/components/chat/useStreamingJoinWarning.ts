// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react'
import type { TaskRuntimeState } from '@wegent/chat-core'
import { getStreamingJoinWarningKey } from './streamingJoinWarning'

interface UseStreamingJoinWarningOptions {
  taskId?: number | null
  phase?: string
  runtime?: TaskRuntimeState | null
  translate: (key: string) => string
  notify: (title: string) => { dismiss: () => void }
}

export function useStreamingJoinWarning({
  taskId,
  phase,
  runtime,
  translate,
  notify,
}: UseStreamingJoinWarningOptions) {
  const lastWarningRef = useRef<string | null>(null)
  const dismissWarningRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!runtime?.activeStreamSubtaskId || phase !== 'streaming') {
      dismissWarningRef.current?.()
      dismissWarningRef.current = null
      lastWarningRef.current = null
      return
    }

    const warningKey = getStreamingJoinWarningKey({
      started_at: runtime.activeStreamStartedAt,
      last_activity_at: runtime.activeStreamLastActivityAt,
    })
    if (!warningKey) {
      dismissWarningRef.current?.()
      dismissWarningRef.current = null
      lastWarningRef.current = null
      return
    }

    const dedupeKey = `${taskId || 0}:${warningKey}`
    if (lastWarningRef.current === dedupeKey) return

    dismissWarningRef.current?.()
    lastWarningRef.current = dedupeKey
    dismissWarningRef.current = notify(translate(warningKey)).dismiss
  }, [
    notify,
    phase,
    runtime?.activeStreamLastActivityAt,
    runtime?.activeStreamStartedAt,
    runtime?.activeStreamSubtaskId,
    taskId,
    translate,
  ])

  useEffect(
    () => () => {
      dismissWarningRef.current?.()
    },
    []
  )
}
