// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSocket } from '@/contexts/SocketContext'
import { useUser } from '@/features/common/UserContext'
import { useOptionalTaskSession } from '@/features/tasks/session/TaskSession'
import type { ChatStatusUpdatedPayload } from '@/types/socket'

const CONTEXT_REMAINING_STATUS_ITEM = 'context-remaining'
const ACTIVE_TASK_STATUS_PATHS = ['/chat', '/code', '/generate', '/devices/chat']

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function isTaskStatusRoute(pathname: string | null): boolean {
  if (!pathname) {
    return false
  }

  return ACTIVE_TASK_STATUS_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))
}

export interface ChatStatusDisplayModel {
  percent: number
  usedTokens: string
  totalTokens: string
  isOverTrigger: boolean
}

export interface ChatStatusIndicatorState {
  enabled: boolean
  shouldRender: boolean
  display: ChatStatusDisplayModel | null
  currentTaskId: number | null
}

export function useChatStatusIndicator(): ChatStatusIndicatorState {
  const { registerChatHandlers } = useSocket()
  const { user } = useUser()
  const taskSession = useOptionalTaskSession()
  const pathname = usePathname()
  const [statusByTaskId, setStatusByTaskId] = useState<Record<number, ChatStatusUpdatedPayload>>({})

  const currentTaskId =
    taskSession?.currentTaskId ??
    taskSession?.selectedTaskDetail?.id ??
    taskSession?.selectedTask?.id ??
    null

  const enabledItems = user?.preferences?.chat_status_items ?? []
  const enabled = enabledItems.includes(CONTEXT_REMAINING_STATUS_ITEM)
  const currentStatus = currentTaskId ? statusByTaskId[currentTaskId] : null
  const supportedRoute = isTaskStatusRoute(pathname)

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
    shouldRender: enabled && supportedRoute && !!currentTaskId && !!display,
    display,
    currentTaskId,
  }
}
