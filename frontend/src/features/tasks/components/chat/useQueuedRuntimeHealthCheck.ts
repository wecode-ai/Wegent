// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react'
import type { QueuedMessageStatus } from './useMessageSendQueue'

interface QueuedRuntimeMessage {
  id: string
  status: QueuedMessageStatus
}

interface UseQueuedRuntimeHealthCheckOptions {
  taskId?: number | null
  queuedMessages: QueuedRuntimeMessage[]
  blocksQueuedDispatch: boolean
  isStreaming: boolean
  hasPendingUserMessage: boolean
  recoverCurrentTask: () => Promise<void>
}

export function useQueuedRuntimeHealthCheck({
  taskId,
  queuedMessages,
  blocksQueuedDispatch,
  isStreaming,
  hasPendingUserMessage,
  recoverCurrentTask,
}: UseQueuedRuntimeHealthCheckOptions) {
  const refreshKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const queuedIds = queuedMessages
      .filter(message => message.status === 'queued')
      .map(message => message.id)

    if (!taskId || queuedIds.length === 0 || !blocksQueuedDispatch) {
      refreshKeyRef.current = null
      return
    }

    if (isStreaming || hasPendingUserMessage) return

    const refreshKey = `${taskId}:${blocksQueuedDispatch}:${queuedIds.join(',')}`
    if (refreshKeyRef.current === refreshKey) return

    refreshKeyRef.current = refreshKey
    void recoverCurrentTask()
  }, [
    blocksQueuedDispatch,
    hasPendingUserMessage,
    isStreaming,
    queuedMessages,
    recoverCurrentTask,
    taskId,
  ])
}
