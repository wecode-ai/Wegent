// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * UI adapter for task messages.
 *
 * TaskSession owns raw runtime messages. This hook adapts those raw messages
 * into DisplayMessage records for MessagesArea and keeps rendering concerns out
 * of the runtime/session layer.
 */

import { useEffect, useMemo } from 'react'
import { useUser } from '@/features/common/UserContext'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import type { Team, Attachment, SubtaskContextBrief } from '@/types/api'
import type { RetrievalSummaryPayload, SourceReference } from '@/types/socket'
import type { MessageBlock } from '../components/message/thinking/types'
import type { UnifiedMessage, SyncOptions } from '@wegent/chat-core'

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
  /** Classified error type from backend (e.g., 'context_length_exceeded') */
  errorType?: string
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
    retrieval_summary?: RetrievalSummaryPayload
    reasoning_content?: string // DeepSeek R1 reasoning content
    blocks?: MessageBlock[] // Message blocks for mixed content rendering
    /** Video generation config (stored in user message subtask for display) */
    video_config?: {
      model?: string
      resolution?: string
      ratio?: string
      duration?: number
    }
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
  /** Whether reasoning content is actively streaming */
  isReasoningStreaming?: boolean
}

interface UseMessagePresenterOptions {
  /** Selected team for display */
  team: Team | null
  /** Whether this is a group chat */
  isGroupChat: boolean
  /**
   * Pending task ID - used before the selected task identity is available.
   * Can be either:
   * - tempTaskId (negative number like -Date.now()) for new tasks before backend responds
   * - taskId (positive number) after backend responds but before selection updates
   */
  pendingTaskId?: number | null
}

interface UseMessagePresenterResult {
  /** Unified message list for display, sorted by timestamp */
  messages: DisplayMessage[]
  /** Whether any message is currently streaming */
  isStreaming: boolean
  /** Set of subtask IDs that are currently streaming */
  streamingSubtaskIds: number[]
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
    errorType: msg.errorType,
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
    isReasoningStreaming: msg.isReasoningStreaming,
  }
}

/**
 * Hook to present TaskSession raw messages.
 */
export function useMessagePresenter({
  team,
  isGroupChat,
  pendingTaskId,
}: UseMessagePresenterOptions): UseMessagePresenterResult {
  const {
    currentTaskId,
    messages: rawMessages,
    isStreaming,
    streamingSubtaskIds: sessionStreamingSubtaskIds,
    setMessageSyncOptions,
  } = useTaskSession()
  const { user } = useUser()

  // Determine effective task ID for querying state machine:
  // - Use currentTaskId (the selected task identity) if available
  // - Otherwise use pendingTaskId (tempTaskId or taskId before selectedTaskDetail updates)
  const effectiveTaskId = currentTaskId || pendingTaskId || undefined

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

  useEffect(() => {
    setMessageSyncOptions(syncOptions)
  }, [setMessageSyncOptions, syncOptions])

  const result = useMemo<UseMessagePresenterResult>(() => {
    if (!effectiveTaskId || rawMessages.size === 0) {
      return {
        messages: [],
        isStreaming,
        streamingSubtaskIds: sessionStreamingSubtaskIds,
      }
    }

    const streamingSubtaskIds = new Set(sessionStreamingSubtaskIds)

    const messages: DisplayMessage[] = []

    for (const [, msg] of rawMessages) {
      const displayMsg = toDisplayMessage(msg, team, isGroupChat, user?.id)
      messages.push(displayMsg)

      // Track streaming AI messages
      if (msg.type === 'ai' && msg.status === 'streaming' && msg.subtaskId) {
        streamingSubtaskIds.add(msg.subtaskId)
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
      isStreaming: streamingSubtaskIds.size > 0 || isStreaming,
      streamingSubtaskIds: Array.from(streamingSubtaskIds),
    }
  }, [
    effectiveTaskId,
    rawMessages,
    sessionStreamingSubtaskIds,
    team,
    isGroupChat,
    user?.id,
    isStreaming,
  ])

  return result
}

export default useMessagePresenter
