// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useUnifiedMessages Hook
 *
 * This hook manages the unified message list for chat display.
 * It is the SINGLE SOURCE OF TRUTH for all messages in the chat UI.
 *
 * Key Design Principles:
 * 1. SINGLE SOURCE OF TRUTH: TaskStateMachine.messages is the ONLY source for rendering
 * 2. AUTOMATIC RECOVERY: State machine handles all recovery scenarios (page refresh, reconnect, visibility)
 * 3. PROPER ORDERING: Messages are sorted by messageId (primary) and timestamp (secondary)
 * 4. STATE ISOLATION: Each message maintains its own state independently
 *
 * Message Flow:
 * 1. Select task -> TaskStateMachine.recover() syncs from backend
 * 2. User sends message -> ChatStreamContext adds to machine via sendMessage
 * 3. chat:start -> Add AI message with status='streaming'
 * 4. chat:chunk -> Update AI message content
 * 5. chat:done -> Update AI message status to 'completed'
 */

import { useMemo, useEffect } from 'react'
import { useTaskStateMachine } from './useTaskStateMachine'
import { useUser } from '@/features/common/UserContext'
import { useTaskContext } from '../contexts/taskContext'
import type { Team, Attachment, SubtaskContextBrief } from '@/types/api'
import type { SourceReference } from '@/types/socket'
import type { MessageBlock } from '../components/message/thinking/types'
import type { UnifiedMessage, SyncOptions } from '../state'

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
    shell_type?: string // Shell type for frontend display (Chat, ClaudeCode, Agno, etc.)
    sources?: SourceReference[] // RAG knowledge base sources
    reasoning_content?: string // DeepSeek R1 reasoning content
    blocks?: MessageBlock[] // Message blocks for mixed content rendering
  }
  /** Knowledge base source references (for RAG citations) - top-level for backward compatibility */
  sources?: SourceReference[]
  /** Whether this message is from the current user (for alignment) */
  isCurrentUser?: boolean
  /** Whether to show the sender avatar/name */
  showSender?: boolean
  /** Recovered content from streaming recovery */
  recoveredContent?: string
  /** Whether this is recovered content */
  isRecovered?: boolean
  /** Whether content is incomplete */
  isIncomplete?: boolean
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
 * Convert UnifiedMessage to DisplayMessage
 */
function toDisplayMessage(
  msg: UnifiedMessage,
  team: Team | null,
  isGroupChat: boolean,
  currentUserId?: number
): DisplayMessage {
  // Handle both singular 'attachment' (from pending messages) and plural 'attachments' (from backend)
  let attachments: Attachment[] | undefined
  if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    attachments = msg.attachments as Attachment[]
  } else if (msg.attachment) {
    attachments = [msg.attachment as Attachment]
  }

  const contexts = msg.contexts as SubtaskContextBrief[] | undefined

  return {
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
    isCurrentUser: msg.type === 'user' && (msg.senderUserId === currentUserId || !msg.senderUserId),
    showSender: isGroupChat && msg.type === 'user',
    reasoningContent: msg.reasoningContent || msg.result?.reasoning_content,
  }
}

/**
 * Hook to manage unified message list
 *
 * This hook uses TaskStateMachine.messages as the ONLY data source for rendering.
 * When a task is selected, it triggers recovery via the state machine.
 */
export function useUnifiedMessages({
  team,
  isGroupChat,
  pendingTaskId,
}: UseUnifiedMessagesOptions): UseUnifiedMessagesResult {
  const { selectedTaskDetail } = useTaskContext()
  const { user } = useUser()

  const taskId = selectedTaskDetail?.id

  // Determine effective task ID for querying state machine:
  // - Use taskId (from selectedTaskDetail) if available
  // - Otherwise use pendingTaskId (tempTaskId or taskId before selectedTaskDetail updates)
  const effectiveTaskId = taskId || pendingTaskId || undefined

  // Build sync options
  const syncOptions: SyncOptions = useMemo(
    () => ({
      teamName: team?.name,
      isGroupChat,
      currentUserId: user?.id,
      currentUserName: user?.user_name,
    }),
    [team?.name, isGroupChat, user?.id, user?.user_name]
  )

  // Use the state machine hook
  const {
    messages: stateMessages,
    isStreaming,
    recover,
    isInitialized,
  } = useTaskStateMachine(effectiveTaskId, syncOptions)

  // Trigger recovery when task changes
  // Subtasks are now fetched from joinTask response, not passed as parameter
  // IMPORTANT: Do NOT recover if already streaming - this would interrupt the stream
  useEffect(() => {
    if (!effectiveTaskId || !isInitialized) return

    // Only recover for positive task IDs (real tasks, not pending)
    // Skip recovery if already streaming to avoid interrupting active streams
    if (effectiveTaskId > 0 && !isStreaming) {
      recover()
    }
  }, [effectiveTaskId, isInitialized, recover, isStreaming])

  // Build unified message list from state machine messages
  const result = useMemo<UseUnifiedMessagesResult>(() => {
    if (!effectiveTaskId || stateMessages.size === 0) {
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

    // Convert state messages to DisplayMessage array
    const messages: DisplayMessage[] = []

    for (const [, msg] of stateMessages) {
      const displayMsg = toDisplayMessage(msg, team, isGroupChat, user?.id)
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
      // If both have messageId, use it as primary sort key
      if (a.messageId !== undefined && b.messageId !== undefined) {
        if (a.messageId !== b.messageId) {
          return a.messageId - b.messageId
        }
        // Same messageId, use timestamp as secondary sort key
        return a.timestamp - b.timestamp
      }
      // If only one has messageId, the one with messageId comes first (it's from backend)
      if (a.messageId !== undefined) return -1
      if (b.messageId !== undefined) return 1
      // Neither has messageId (both pending), sort by timestamp
      return a.timestamp - b.timestamp
    })

    return {
      messages: sortedMessages,
      isStreaming: streamingSubtaskIds.length > 0 || isStreaming,
      streamingSubtaskIds,
      hasPendingMessages,
      subtasksMap,
      pendingMessages,
    }
  }, [effectiveTaskId, stateMessages, team, isGroupChat, user?.id, isStreaming])

  return result
}

export default useUnifiedMessages
