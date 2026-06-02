// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react'
import type { ChatEventHandlers } from '@/contexts/SocketContext'

interface UseGuidanceSocketHandlersOptions {
  taskId?: number | null
  registerChatHandlers: (handlers: ChatEventHandlers) => () => void
  markGuidanceApplied: (guidanceId: string) => void
  markGuidanceExpired: (guidanceId: string, error?: string) => void
  expiredMessage: string
}

export function useGuidanceSocketHandlers({
  taskId,
  registerChatHandlers,
  markGuidanceApplied,
  markGuidanceExpired,
  expiredMessage,
}: UseGuidanceSocketHandlersOptions) {
  useEffect(() => {
    if (!taskId) return

    return registerChatHandlers({
      onGuidanceApplied: payload => {
        if (payload.task_id === taskId) {
          markGuidanceApplied(payload.guidance_id)
        }
      },
      onGuidanceExpired: payload => {
        if (payload.task_id === taskId) {
          payload.guidance_ids.forEach(id => markGuidanceExpired(id, expiredMessage))
        }
      },
    })
  }, [expiredMessage, markGuidanceApplied, markGuidanceExpired, registerChatHandlers, taskId])
}
