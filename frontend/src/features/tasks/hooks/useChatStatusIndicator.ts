// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSocket } from '@/contexts/SocketContext'
import { useUser } from '@/features/common/UserContext'
import { useOptionalTaskSession } from '@/features/tasks/session/TaskSession'
import type { UnifiedMessage } from '@/features/tasks/state'
import type { ChatStatusUpdatedPayload } from '@/types/socket'

const CONTEXT_REMAINING_STATUS_ITEM = 'context-remaining'
const PERSISTED_PHASE = 'persisted'

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat().format(value)
}

/**
 * Derive a status payload from the most recent AI message that carries a
 * persisted context_metrics snapshot. Used as a cold-load fallback before any
 * live `chat:status_updated` event arrives in this session.
 */
function deriveStatusFromMessages(
  taskId: number,
  messages: Map<string, UnifiedMessage>
): ChatStatusUpdatedPayload | null {
  let latest: UnifiedMessage | null = null
  for (const message of messages.values()) {
    if (message.type !== 'ai') continue
    if (!message.result?.context_metrics) continue
    if (!latest || message.timestamp > latest.timestamp) {
      latest = message
    }
  }

  if (!latest?.result?.context_metrics) return null

  return {
    task_id: taskId,
    subtask_id: latest.subtaskId ?? 0,
    phase: PERSISTED_PHASE,
    context_metrics: latest.result.context_metrics,
  }
}

export interface ChatStatusDisplayModel {
  percent: number
  usedTokens: string
  totalTokens: string
  isOverTrigger: boolean
}

export interface ChatStatusIndicatorState {
  enabled: boolean
  display: ChatStatusDisplayModel | null
  currentTaskId: number | null
}

export function useChatStatusIndicator(): ChatStatusIndicatorState {
  const { registerChatHandlers } = useSocket()
  const { user } = useUser()
  const taskSession = useOptionalTaskSession()
  const [statusByTaskId, setStatusByTaskId] = useState<Record<number, ChatStatusUpdatedPayload>>({})

  const currentTaskId =
    taskSession?.currentTaskId ??
    taskSession?.selectedTaskDetail?.id ??
    taskSession?.selectedTask?.id ??
    null

  const enabledItems = user?.preferences?.chat_status_items ?? []
  const enabled = enabledItems.includes(CONTEXT_REMAINING_STATUS_ITEM)
  const liveStatus = currentTaskId ? statusByTaskId[currentTaskId] : null

  const fallbackStatus = useMemo<ChatStatusUpdatedPayload | null>(() => {
    if (!currentTaskId || liveStatus) return null
    const messages = taskSession?.messages
    if (!messages || messages.size === 0) return null
    return deriveStatusFromMessages(currentTaskId, messages)
  }, [currentTaskId, liveStatus, taskSession?.messages])

  const currentStatus = liveStatus ?? fallbackStatus

  useEffect(() => {
    return registerChatHandlers({
      onChatStatusUpdated: payload => {
        setStatusByTaskId(previous => ({
          ...previous,
          [payload.task_id]: payload,
        }))
      },
    })
  }, [registerChatHandlers])

  const display = useMemo<ChatStatusDisplayModel | null>(() => {
    if (!currentStatus) {
      return null
    }

    const metrics = currentStatus.context_metrics
    return {
      percent: Math.max(
        0,
        Math.min(100, Math.round(metrics.display_remaining_percent ?? metrics.remaining_percent))
      ),
      usedTokens: formatTokenCount(metrics.used_input_tokens),
      totalTokens: formatTokenCount(metrics.context_window),
      isOverTrigger: metrics.is_over_trigger,
    }
  }, [currentStatus])

  return {
    enabled,
    display,
    currentTaskId,
  }
}
