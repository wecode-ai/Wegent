// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Group Chat Sync Manager Component
 *
 * Handles polling for new messages in group chats.
 * This component should be mounted when a group chat task is active.
 *
 * Note: Streaming content recovery for other users' messages is handled by
 * useMultipleStreamingRecovery in MessagesArea, which detects RUNNING ASSISTANT
 * subtasks and recovers their streaming content via the unified stream endpoint.
 * This simplifies the architecture by using a single mechanism for all streaming recovery.
 */

import { useEffect, useRef } from 'react'
import { useGroupChatPolling } from '@/hooks/useGroupChatPolling'
import type { SubtaskWithSender } from '@/apis/group-chat'

interface GroupChatSyncManagerProps {
  taskId: number
  isGroupChat: boolean
  enabled?: boolean
  /** Callback when new messages are detected via polling */
  onNewMessages?: (messages: SubtaskWithSender[]) => void
  /** Callback when a stream completes (detected via polling) */
  onStreamComplete?: (subtaskId: number, result?: Record<string, unknown>) => void
}

/**
 * Manager component for group chat message polling
 *
 * Usage:
 * ```tsx
 * <GroupChatSyncManager
 *   taskId={currentTaskId}
 *   isGroupChat={task.isGroupChat}
 *   enabled={isActive}
 *   onNewMessages={(messages) => {
 *     // Refresh task detail to show new messages
 *     refreshSelectedTaskDetail()
 *   }}
 *   onStreamComplete={(subtaskId) => {
 *     // Refresh to get the final message
 *     refreshSelectedTaskDetail()
 *   }}
 * />
 * ```
 */
export function GroupChatSyncManager({
  taskId,
  isGroupChat,
  enabled = true,
  onNewMessages,
  onStreamComplete,
}: GroupChatSyncManagerProps) {
  // Polling for new messages
  // Note: streamingSubtaskId is still tracked by polling, but streaming content
  // recovery is handled by useMultipleStreamingRecovery in MessagesArea
  const {
    streamingSubtaskId,
    hasStreaming,
    error: pollingError,
    clearMessages,
  } = useGroupChatPolling({
    taskId,
    isGroupChat,
    enabled,
    onNewMessages,
    onStreamingDetected: subtaskId => {
      console.log('[GroupChatSync] Stream detected:', subtaskId)
    },
  })

  // When streaming completes (hasStreaming becomes false after being true),
  // notify the parent to refresh
  const prevHasStreamingRef = useRef<boolean>(false)
  useEffect(() => {
    // If we were streaming and now we're not, stream completed
    if (prevHasStreamingRef.current && !hasStreaming && streamingSubtaskId) {
      if (onStreamComplete) {
        onStreamComplete(streamingSubtaskId)
      }
    }
    prevHasStreamingRef.current = hasStreaming
  }, [hasStreaming, streamingSubtaskId, onStreamComplete])

  // Log errors
  useEffect(() => {
    if (pollingError) {
      console.error('[GroupChatSync] Polling error:', pollingError)
    }
  }, [pollingError])

  // Cleanup messages when unmounting
  useEffect(() => {
    return () => {
      clearMessages()
    }
  }, [clearMessages])

  // This component doesn't render anything - it's purely for side effects
  return null
}
