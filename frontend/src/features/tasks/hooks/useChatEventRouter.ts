// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useChatEventRouter Hook
 *
 * Routes WebSocket chat events to TaskStateManager.
 * This is the bridge between SocketContext and TaskStateMachine.
 *
 * Should be called once in the app (e.g., in ChatStreamProvider).
 */

import { useEffect, useRef, useCallback } from 'react'
import { useSocket, ChatEventHandlers } from '@/contexts/SocketContext'
import { taskStateManager } from '../state'
import type {
  ChatStartPayload,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatCancelledPayload,
  ChatMessagePayload,
} from '@/types/socket'

/**
 * Hook to route chat events to TaskStateManager
 */
export function useChatEventRouter(): void {
  const { registerChatHandlers } = useSocket()

  // Track subtask to task mapping
  const subtaskToTaskRef = useRef<Map<number, number>>(new Map())

  // Handle chat:start event
  const handleChatStart = useCallback((data: ChatStartPayload) => {
    const { task_id, subtask_id, bot_name, shell_type } = data

    // Track subtask to task mapping
    if (subtask_id) {
      subtaskToTaskRef.current.set(subtask_id, task_id)
    }

    // Route to state machine
    const machine = taskStateManager.getOrCreate(task_id)
    machine.handleChatStart(subtask_id, bot_name, shell_type)
  }, [])

  // Handle chat:chunk event
  const handleChatChunk = useCallback((data: ChatChunkPayload) => {
    const { subtask_id, content, result } = data

    // Find task ID from subtask mapping
    const taskId = subtaskToTaskRef.current.get(subtask_id)
    if (!taskId) {
      console.warn('[useChatEventRouter] Received chunk for unknown subtask:', subtask_id)
      return
    }

    // Route to state machine
    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.handleChatChunk(subtask_id, content, result)
    }
  }, [])

  // Handle chat:done event
  const handleChatDone = useCallback((data: ChatDonePayload) => {
    const { task_id: eventTaskId, subtask_id, result, message_id } = data

    // Find task ID from subtask mapping or use event task_id
    let taskId = subtaskToTaskRef.current.get(subtask_id)
    if (!taskId && eventTaskId) {
      taskId = eventTaskId
      subtaskToTaskRef.current.set(subtask_id, taskId)
    }

    if (!taskId) {
      console.warn('[useChatEventRouter] Unknown subtask in chat:done:', subtask_id)
      return
    }

    // Route to state machine
    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.handleChatDone(subtask_id, result, message_id)
    }
  }, [])

  // Handle chat:error event
  const handleChatError = useCallback((data: ChatErrorPayload) => {
    const { subtask_id, error } = data

    // Find task ID from subtask mapping
    const taskId = subtaskToTaskRef.current.get(subtask_id)
    if (!taskId) {
      console.warn('[useChatEventRouter] Unknown subtask in chat:error:', subtask_id)
      return
    }

    // Route to state machine
    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.handleChatError(subtask_id, error)
    }
  }, [])

  // Handle chat:cancelled event
  const handleChatCancelled = useCallback((data: ChatCancelledPayload) => {
    const { task_id: eventTaskId, subtask_id } = data

    // Find task ID
    let taskId = subtaskToTaskRef.current.get(subtask_id)
    if (!taskId && eventTaskId) {
      taskId = eventTaskId
    }

    if (!taskId) {
      console.warn('[useChatEventRouter] Unknown subtask in chat:cancelled:', subtask_id)
      return
    }

    // Route to state machine
    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.handleChatCancelled(subtask_id)
    }
  }, [])

  // Handle chat:message event (group chat, other users' messages)
  const handleChatMessage = useCallback((data: ChatMessagePayload) => {
    const { task_id, subtask_id, message_id, content, sender, contexts } = data

    // Track subtask to task mapping
    subtaskToTaskRef.current.set(subtask_id, task_id)

    // Route to state machine
    // Cast contexts to SubtaskContextBrief[] - the types are compatible at runtime
    const machine = taskStateManager.getOrCreate(task_id)
    machine.handleChatMessage(
      subtask_id,
      content || '',
      message_id,
      sender?.user_name,
      sender?.user_id,
      contexts as unknown[]
    )
  }, [])

  // Register event handlers
  useEffect(() => {
    const handlers: ChatEventHandlers = {
      onChatStart: handleChatStart,
      onChatChunk: handleChatChunk,
      onChatDone: handleChatDone,
      onChatError: handleChatError,
      onChatCancelled: handleChatCancelled,
      onChatMessage: handleChatMessage,
    }

    const cleanup = registerChatHandlers(handlers)
    return cleanup
  }, [
    registerChatHandlers,
    handleChatStart,
    handleChatChunk,
    handleChatDone,
    handleChatError,
    handleChatCancelled,
    handleChatMessage,
  ])
}

export default useChatEventRouter
