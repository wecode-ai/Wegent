// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react'
import type { TaskDetail } from '../../../types/api'
import type { TaskStateData } from '../state'

interface StreamHandlersState {
  hasPendingUserMessage: boolean
  isStreaming: boolean
  pendingTaskId: number | null
  localPendingMessage: unknown | null
}

interface UseHasMessagesParams {
  selectedTask: { id: number } | null
  selectedTaskDetail: TaskDetail | null
  taskState: TaskStateData | null
  streamHandlers: StreamHandlersState
}

/**
 * Determines if there are messages to display in the chat area.
 *
 * Logic breakdown:
 * - hasSelectedTask: Has loaded task detail with messages
 * - isLoadingTask: Task is selected but details are still loading (prevents flash)
 * - hasNewTaskStream: New task being created with streaming
 * - hasLocalPending: Local pending message waiting to be sent
 * - hasUnifiedMessages: Messages exist in state machine
 */
export function useHasMessages({
  selectedTask,
  selectedTaskDetail,
  taskState,
  streamHandlers,
}: UseHasMessagesParams): boolean {
  return useMemo(() => {
    const hasSelectedTask = selectedTaskDetail?.id != null
    const isLoadingTask = selectedTask != null && selectedTaskDetail == null
    const hasNewTaskStream =
      !selectedTaskDetail?.id && streamHandlers.pendingTaskId != null && streamHandlers.isStreaming
    const hasLocalPending = streamHandlers.localPendingMessage != null
    const hasUnifiedMessages = taskState?.messages != null && taskState.messages.size > 0

    // Fast path: task with messages loaded
    if (hasSelectedTask && hasUnifiedMessages) {
      return true
    }

    // Check any condition that indicates chat should be shown
    return (
      hasSelectedTask ||
      isLoadingTask ||
      streamHandlers.hasPendingUserMessage ||
      streamHandlers.isStreaming ||
      hasNewTaskStream ||
      hasLocalPending ||
      hasUnifiedMessages
    )
  }, [
    selectedTask,
    selectedTaskDetail,
    taskState?.messages,
    streamHandlers.hasPendingUserMessage,
    streamHandlers.isStreaming,
    streamHandlers.pendingTaskId,
    streamHandlers.localPendingMessage,
  ])
}
