// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react'
import { taskStateManager } from '../../state'
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
  isAwaitingResponseStart: boolean
}

export function useQueuedRuntimeHealthCheck({
  taskId,
  queuedMessages,
  blocksQueuedDispatch,
  isStreaming,
  isAwaitingResponseStart,
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

    if (isStreaming || isAwaitingResponseStart) return

    const refreshKey = `${taskId}:${blocksQueuedDispatch}:${queuedIds.join(',')}`
    if (refreshKeyRef.current === refreshKey) return

    refreshKeyRef.current = refreshKey
    const machine = taskStateManager.get(taskId)
    void machine?.checkHealth('queued-message-blocked')
  }, [blocksQueuedDispatch, isAwaitingResponseStart, isStreaming, queuedMessages, taskId])
}
