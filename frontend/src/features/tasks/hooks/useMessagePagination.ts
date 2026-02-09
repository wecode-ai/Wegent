// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useMessagePagination Hook
 *
 * Handles pagination for loading older messages in task chat history.
 * Provides infinite scroll functionality with proper state management.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { subtaskApis, SubtaskListResponse } from '@/apis/subtasks'
import type { TaskDetailSubtask } from '@/types/api'
import { taskStateManager, UnifiedMessage } from '../state'

export interface UseMessagePaginationOptions {
  /** Task ID for the messages */
  taskId: number | null | undefined
  /** Total messages count from task detail */
  totalMessages: number
  /** Team name for display */
  teamName?: string
  /** Whether this is a group chat */
  isGroupChat?: boolean
  /** Current user ID */
  currentUserId?: number
  /** Current user name */
  currentUserName?: string
}

export interface UseMessagePaginationResult {
  /** Whether more messages are available */
  hasMoreMessages: boolean
  /** Whether currently loading more messages */
  isLoadingMore: boolean
  /** Number of loaded messages */
  loadedCount: number
  /** Total messages count */
  totalCount: number
  /** Load more messages (older messages) */
  loadMoreMessages: () => Promise<void>
  /** Error message if loading failed */
  error: string | null
  /** Reset pagination state (when task changes) */
  resetPagination: () => void
}

const PAGE_SIZE = 50

/**
 * Hook to manage message pagination for infinite scroll
 */
export function useMessagePagination({
  taskId,
  totalMessages,
  teamName,
  isGroupChat,
  currentUserId,
  currentUserName,
}: UseMessagePaginationOptions): UseMessagePaginationResult {
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasLoadedAll, setHasLoadedAll] = useState(false)
  const [loadedCount, setLoadedCount] = useState(0)

  // Use ref to prevent concurrent calls (more reliable than state for race conditions)
  const isLoadingMoreRef = useRef(false)
  // Track the oldest message ID we've loaded
  const oldestMessageIdRef = useRef<number | null>(null)
  // Track last task ID to reset state when task changes
  const lastTaskIdRef = useRef<number | null>(null)

  // Reset pagination when task changes
  useEffect(() => {
    if (taskId !== lastTaskIdRef.current) {
      lastTaskIdRef.current = taskId ?? null
      setHasLoadedAll(false)
      setError(null)
      oldestMessageIdRef.current = null
      setLoadedCount(0)
      isLoadingMoreRef.current = false
    }
  }, [taskId])

  // Update loaded count when state machine updates
  useEffect(() => {
    if (!taskId) {
      setLoadedCount(0)
      return
    }

    const machine = taskStateManager.get(taskId)
    if (machine) {
      const updateCount = () => {
        const state = machine.getState()
        setLoadedCount(state.messages.size)

        // Check if we've loaded all messages
        if (totalMessages > 0) {
          setHasLoadedAll(state.messages.size >= totalMessages)
        }
      }

      // Get initial count
      updateCount()

      // Subscribe to updates
      const unsubscribe = machine.subscribe(updateCount)
      return unsubscribe
    }
  }, [taskId, totalMessages])

  /**
   * Load more (older) messages
   */
  const loadMoreMessages = useCallback(async () => {
    // Use ref to prevent concurrent calls
    if (!taskId || isLoadingMoreRef.current || hasLoadedAll) return

    // Set ref synchronously to prevent races
    isLoadingMoreRef.current = true
    setIsLoadingMore(true)
    setError(null)

    try {
      // Get current state machine to find oldest message
      const machine = taskStateManager.get(taskId)
      if (!machine) {
        setError('State machine not found')
        return
      }

      const currentState = machine.getState()
      const currentMessages = Array.from(currentState.messages.values())

      // Find the oldest messageId (lowest messageId value)
      let oldestMessageId: number | undefined
      for (const msg of currentMessages) {
        if (msg.messageId !== undefined) {
          if (oldestMessageId === undefined || msg.messageId < oldestMessageId) {
            oldestMessageId = msg.messageId
          }
        }
      }

      // If no messages with messageId, we can't paginate
      if (oldestMessageId === undefined) {
        setHasLoadedAll(true)
        return
      }

      // Fetch older messages using before_message_id parameter
      const response: SubtaskListResponse = await subtaskApis.listSubtasks({
        taskId,
        limit: PAGE_SIZE,
        fromLatest: false, // Get messages in ascending order
        beforeMessageId: oldestMessageId,
      })

      if (response.items.length === 0) {
        setHasLoadedAll(true)
        return
      }

      // Convert subtasks to UnifiedMessage and add to state machine
      const newMessages = convertSubtasksToMessages(response.items, {
        teamName,
        isGroupChat,
        currentUserId,
        currentUserName,
      })

      // Merge new messages into state machine
      machine.mergeOlderMessages(newMessages)

      // Check if we've loaded all messages
      if (response.items.length < PAGE_SIZE) {
        setHasLoadedAll(true)
      }

      // Update oldest message ID reference
      oldestMessageIdRef.current = response.items.reduce((min, item) => {
        return item.message_id < min ? item.message_id : min
      }, response.items[0]?.message_id ?? Infinity)
    } catch (err) {
      console.error('[useMessagePagination] Failed to load more messages:', err)
      setError(err instanceof Error ? err.message : 'Failed to load messages')
    } finally {
      isLoadingMoreRef.current = false
      setIsLoadingMore(false)
    }
  }, [taskId, hasLoadedAll, teamName, isGroupChat, currentUserId, currentUserName])

  /**
   * Reset pagination state (when task changes)
   */
  const resetPagination = useCallback(() => {
    setHasLoadedAll(false)
    setError(null)
    oldestMessageIdRef.current = null
    setLoadedCount(0)
  }, [])

  const hasMoreMessages = !hasLoadedAll && loadedCount < totalMessages && totalMessages > 0

  return {
    hasMoreMessages,
    isLoadingMore,
    loadedCount,
    totalCount: totalMessages,
    loadMoreMessages,
    error,
    resetPagination,
  }
}

/**
 * Convert backend subtasks to UnifiedMessage format
 */
function convertSubtasksToMessages(
  subtasks: TaskDetailSubtask[],
  options: {
    teamName?: string
    isGroupChat?: boolean
    currentUserId?: number
    currentUserName?: string
  }
): UnifiedMessage[] {
  const { teamName, isGroupChat, currentUserId, currentUserName } = options
  const messages: UnifiedMessage[] = []

  for (const subtask of subtasks) {
    const isUserMessage = subtask.role === 'USER' || subtask.role?.toUpperCase() === 'USER'
    const messageId = isUserMessage ? `user-backend-${subtask.id}` : `ai-${subtask.id}`

    // Determine status
    let status: 'pending' | 'streaming' | 'completed' | 'error' = 'completed'
    if (subtask.status === 'RUNNING') {
      status = 'streaming'
    } else if (subtask.status === 'FAILED' || subtask.status === 'CANCELLED') {
      status = 'error'
    } else if (subtask.status === 'PENDING') {
      status = 'pending'
    }

    // Get content
    const content = isUserMessage
      ? subtask.prompt || ''
      : typeof subtask.result?.value === 'string'
        ? subtask.result.value
        : ''

    messages.push({
      id: messageId,
      type: isUserMessage ? 'user' : 'ai',
      status,
      content,
      timestamp: new Date(subtask.created_at).getTime(),
      subtaskId: subtask.id,
      messageId: subtask.message_id,
      attachments: subtask.attachments,
      contexts: subtask.contexts,
      botName: !isUserMessage && subtask.bots?.[0]?.name ? subtask.bots[0].name : teamName,
      senderUserName:
        subtask.sender_user_name ||
        (isUserMessage && subtask.sender_user_id === currentUserId ? currentUserName : undefined),
      senderUserId: subtask.sender_user_id || (isUserMessage ? currentUserId : undefined),
      shouldShowSender: isGroupChat && isUserMessage,
      subtaskStatus: subtask.status,
      result: subtask.result as UnifiedMessage['result'],
      error: subtask.error_message || undefined,
    })
  }

  return messages
}

export default useMessagePagination
