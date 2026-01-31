// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useUnifiedMessages Hook (State Machine Version)
 *
 * This hook manages the unified message list for chat display using TaskStateMachine.
 * It is the SINGLE SOURCE OF TRUTH for all messages in the chat UI.
 *
 * Key Design Principles:
 * 1. SINGLE SOURCE OF TRUTH: TaskStateMachine.messages is the ONLY source for rendering
 * 2. AUTOMATIC RECOVERY: Calls recover() when task/subtasks change
 * 3. PROPER ORDERING: Messages are sorted by messageId (primary) and timestamp (fallback)
 * 4. REENTRANT: Multiple triggers don't cause issues due to state machine design
 */

import { useMemo, useEffect } from 'react'
import { useUser } from '@/features/common/UserContext'
import { useTaskContext } from '../contexts/taskContext'
import { useTaskStateMachine } from './useTaskStateMachine'
import { taskStateManager } from '../state'
import type { Team, Attachment, SubtaskContextBrief } from '@/types/api'
import type { SourceReference } from '@/types/socket'
import type { MessageBlock } from '../components/message/thinking/types'

/**
 * Message for display - extends UnifiedMessage with additional rendering info
 */
export interface DisplayMessage {
  /** Unique ID for this message */
  id: string
  /** Message type: user or ai */
  type: 'user' | 'ai'
  /** Message status */
  status: 'pending' | 'streaming' | 'completed' | 'error'
  /** Message content */
  content: string
  /** Timestamp when message was created */
  timestamp: number
  /** Subtask ID from backend (set when confirmed) */
  subtaskId?: number
  /** Message ID from backend for ordering (primary sort key) */
  messageId?: number
  /** Error message if status is 'error' */
  error?: string
  /** Attachments array (deprecated, use contexts) */
  attachments?: Attachment[]
  /** Unified contexts (attachments, knowledge bases, etc.) */
  contexts?: SubtaskContextBrief[]
  /** Bot name for AI messages */
  botName?: string
  /** Sender user name for group chat */
  senderUserName?: string
  /** Sender user ID for group chat alignment */
  senderUserId?: number
  /** Whether to show sender info (for group chat) */
  shouldShowSender?: boolean
  /** Subtask status from backend (RUNNING, COMPLETED, etc.) */
  subtaskStatus?: string
  /** Thinking data for AI messages */
  thinking?: unknown
  /** Full result data from backend (for executor tasks and shell_type) */
  result?: {
    value?: string
    thinking?: unknown[]
    workbench?: Record<string, unknown>
    shell_type?: string
    sources?: SourceReference[]
    reasoning_content?: string
    blocks?: MessageBlock[]
  }
  /** Knowledge base source references (for RAG citations) */
  sources?: SourceReference[]
  /** Whether this message is from the current user (for alignment) */
  isCurrentUser?: boolean
  /** Whether to show the sender avatar/name */
  showSender?: boolean
  /** Reasoning/thinking content from DeepSeek R1 and similar models */
  reasoningContent?: string
}

interface UseUnifiedMessagesOptions {
  /** Selected team for display */
  team: Team | null
  /** Whether this is a group chat */
  isGroupChat: boolean
  /**
   * Pending task ID - used when selectedTaskDetail.id is not yet available.
   * Can be either:
   * - tempTaskId (negative number like -Date.now()) for new tasks before backend responds
   * - taskId (positive number) after backend responds but before selectedTaskDetail updates
   */
  pendingTaskId?: number | null
}

interface UseUnifiedMessagesResult {
  /** Unified message list for display, sorted by timestamp */
  messages: DisplayMessage[]
  /** Whether any message is currently streaming */
  isStreaming: boolean
  /** Set of subtask IDs that are currently streaming */
  streamingSubtaskIds: number[]
  /** Whether there are any pending user messages */
  hasPendingMessages: boolean
  /** Map of subtask ID to streaming state (for StreamingMessageBubble) */
  subtasksMap: Map<number, { content: string; isStreaming: boolean }>
  /** Pending messages that are not yet in displayMessages */
  pendingMessages: Array<{
    id: string
    content: string
    timestamp: number
    attachment?: Attachment
  }>
}

/**
 * Hook to manage unified message list using TaskStateMachine
 */
export function useUnifiedMessages({
  team,
  isGroupChat,
  pendingTaskId,
}: UseUnifiedMessagesOptions): UseUnifiedMessagesResult {
  const { selectedTaskDetail } = useTaskContext()
  const { user } = useUser()

  const taskId = selectedTaskDetail?.id
  const subtasks = selectedTaskDetail?.subtasks

  // Determine effective task ID for querying state machine:
  // - Use taskId (from selectedTaskDetail) if available
  // - Otherwise use pendingTaskId (tempTaskId or taskId before selectedTaskDetail updates)
  const effectiveTaskId = taskId || pendingTaskId || undefined

  // Get state machine state via hook
  const { messages: machineMessages, isStreaming: machineIsStreaming } =
    useTaskStateMachine(effectiveTaskId)

  // Auto-recover when task or subtasks change
  useEffect(() => {
    if (taskId && subtasks && subtasks.length > 0) {
      const machine = taskStateManager.getOrCreate(taskId)
      machine.recover({
        subtasks,
        teamName: team?.name,
        isGroupChat,
        currentUserId: user?.id,
        currentUserName: user?.user_name,
      })
    }
  }, [taskId, subtasks, team?.name, isGroupChat, user?.id, user?.user_name])

  // Build unified message list from state machine messages
  const result = useMemo<UseUnifiedMessagesResult>(() => {
    if (!effectiveTaskId || !machineMessages || machineMessages.size === 0) {
      return {
        messages: [],
        isStreaming: false,
        streamingSubtaskIds: [],
        hasPendingMessages: false,
        subtasksMap: new Map(),
        pendingMessages: [],
      }
    }

    const streamingSubtaskIds: number[] = []
    let hasPendingMessages = false
    const subtasksMap = new Map<number, { content: string; isStreaming: boolean }>()
    const pendingMessages: Array<{
      id: string
      content: string
      timestamp: number
      attachment?: Attachment
    }> = []

    // Convert state machine messages to DisplayMessage array
    const messages: DisplayMessage[] = []

    for (const [, msg] of machineMessages) {
      // Handle both singular 'attachment' and plural 'attachments'
      let attachments: Attachment[] | undefined
      if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        attachments = msg.attachments as Attachment[]
      } else if (msg.attachment) {
        attachments = [msg.attachment as Attachment]
      }

      const contexts = msg.contexts as SubtaskContextBrief[] | undefined

      const displayMsg: DisplayMessage = {
        id: msg.id,
        type: msg.type,
        status: msg.status,
        content: msg.content,
        timestamp: msg.timestamp,
        subtaskId: msg.subtaskId,
        messageId: msg.messageId,
        error: msg.error,
        attachments,
        contexts,
        botName: msg.botName || team?.name,
        senderUserName: msg.senderUserName,
        senderUserId: msg.senderUserId,
        shouldShowSender: msg.shouldShowSender || (isGroupChat && msg.type === 'user'),
        subtaskStatus: msg.subtaskStatus,
        thinking: msg.result?.thinking,
        result: msg.result,
        sources: msg.sources || msg.result?.sources,
        isCurrentUser: msg.type === 'user' && (msg.senderUserId === user?.id || !msg.senderUserId),
        showSender: isGroupChat && msg.type === 'user',
        reasoningContent: msg.reasoningContent || msg.result?.reasoning_content,
      }

      messages.push(displayMsg)

      // Track pending user messages
      if (msg.type === 'user' && msg.status === 'pending') {
        hasPendingMessages = true
        pendingMessages.push({
          id: msg.id,
          content: msg.content,
          timestamp: msg.timestamp,
          attachment: msg.attachment as Attachment | undefined,
        })
      }

      // Track streaming AI messages
      if (msg.type === 'ai' && msg.status === 'streaming' && msg.subtaskId) {
        streamingSubtaskIds.push(msg.subtaskId)
        subtasksMap.set(msg.subtaskId, {
          content: msg.content,
          isStreaming: true,
        })
      }
    }

    // Sort messages by messageId (primary) and timestamp (secondary)
    const sortedMessages = messages.sort((a, b) => {
      if (a.messageId !== undefined && b.messageId !== undefined) {
        if (a.messageId !== b.messageId) {
          return a.messageId - b.messageId
        }
        return a.timestamp - b.timestamp
      }
      if (a.messageId !== undefined) return -1
      if (b.messageId !== undefined) return 1
      return a.timestamp - b.timestamp
    })

    return {
      messages: sortedMessages,
      isStreaming: machineIsStreaming || streamingSubtaskIds.length > 0,
      streamingSubtaskIds,
      hasPendingMessages,
      subtasksMap,
      pendingMessages,
    }
  }, [effectiveTaskId, machineMessages, machineIsStreaming, team?.name, isGroupChat, user?.id])

  return result
}

export default useUnifiedMessages
