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
 * 1. SINGLE SOURCE OF TRUTH: streamState.messages is the ONLY source for rendering
 * 2. INITIALIZATION: When selecting a task, sync backend subtasks to streamState.messages
 * 3. PROPER ORDERING: Messages are sorted by timestamp
 * 4. STATE ISOLATION: Each message maintains its own state independently
 *
 * Message Flow:
 * 1. Select task -> Sync backend subtasks to streamState.messages (initialization)
 * 2. User sends message -> Add to streamState.messages with status='pending'
 * 3. Backend confirms -> Update message status to 'completed', set subtaskId
 * 4. AI starts -> Add AI message with status='streaming'
 * 5. AI chunks -> Update AI message content
 * 6. AI done -> Update AI message status to 'completed'
 *
 * This hook solves the "progress bar placeholder" bug by ensuring each message
 * has its own state and content, preventing state mixing when sending follow-up messages.
 */

import { useMemo, useEffect, useRef } from 'react';
import { useChatStreamContext, computeIsStreaming } from '../contexts/chatStreamContext';
import { useUser } from '@/features/common/UserContext';
import { useTaskContext } from '../contexts/taskContext';
import type { Team, Attachment } from '@/types/api';

/**
 * Message for display - extends UnifiedMessage with additional rendering info
 */
export interface DisplayMessage {
  /** Unique ID for this message */
  id: string;
  /** Message type: user or ai */
  type: 'user' | 'ai';
  /** Message status */
  status: 'pending' | 'streaming' | 'completed' | 'error';
  /** Message content */
  content: string;
  /** Timestamp when message was created */
  timestamp: number;
  /** Subtask ID from backend (set when confirmed) */
  subtaskId?: number;
  /** Message ID from backend for ordering (primary sort key) */
  messageId?: number;
  /** Error message if status is 'error' */
  error?: string;
  /** Attachments array */
  attachments?: Attachment[];
  /** Bot name for AI messages */
  botName?: string;
  /** Sender user name for group chat */
  senderUserName?: string;
  /** Sender user ID for group chat alignment */
  senderUserId?: number;
  /** Whether to show sender info (for group chat) */
  shouldShowSender?: boolean;
  /** Subtask status from backend (RUNNING, COMPLETED, etc.) */
  subtaskStatus?: string;
  /** Thinking data for AI messages */
  thinking?: unknown;
  /** Full result data from backend (for executor tasks and shell_type) */
  result?: {
    value?: string;
    thinking?: unknown[];
    workbench?: Record<string, unknown>;
    shell_type?: string; // Shell type for frontend display (Chat, ClaudeCode, Agno, etc.)
  };
  /** Whether this message is from the current user (for alignment) */
  isCurrentUser?: boolean;
  /** Whether to show the sender avatar/name */
  showSender?: boolean;
  /** Recovered content from streaming recovery */
  recoveredContent?: string;
  /** Whether this is recovered content */
  isRecovered?: boolean;
  /** Whether content is incomplete */
  isIncomplete?: boolean;
}

interface UseUnifiedMessagesOptions {
  /** Selected team for display */
  team: Team | null;
  /** Whether this is a group chat */
  isGroupChat: boolean;
}

interface UseUnifiedMessagesResult {
  /** Unified message list for display, sorted by timestamp */
  messages: DisplayMessage[];
  /** Whether any message is currently streaming */
  isStreaming: boolean;
  /** Set of subtask IDs that are currently streaming */
  streamingSubtaskIds: number[];
  /** Whether there are any pending user messages */
  hasPendingMessages: boolean;
  /** Map of subtask ID to streaming state (for StreamingMessageBubble) */
  subtasksMap: Map<number, { content: string; isStreaming: boolean }>;
  /** Pending messages that are not yet in displayMessages */
  pendingMessages: Array<{
    id: string;
    content: string;
    timestamp: number;
    attachment?: Attachment;
  }>;
}

/**
 * Hook to manage unified message list
 *
 * This hook uses streamState.messages as the ONLY data source for rendering.
 * When a task is selected, it syncs backend subtasks to streamState.messages.
 */
export function useUnifiedMessages({
  team,
  isGroupChat,
}: UseUnifiedMessagesOptions): UseUnifiedMessagesResult {
  const { getStreamState, syncBackendMessages } = useChatStreamContext();
  const { selectedTaskDetail } = useTaskContext();
  const { user } = useUser();

  const taskId = selectedTaskDetail?.id;
  const subtasks = selectedTaskDetail?.subtasks;

  // Track the last synced task to avoid unnecessary syncs
  const lastSyncedTaskIdRef = useRef<number | undefined>(undefined);

  // Get stream state for current task - this will update when streamStates changes
  // because getStreamState depends on streamStates via useCallback
  const streamState = taskId ? getStreamState(taskId) : undefined;

  // Sync backend subtasks to streamState.messages when task changes
  // This initializes the message list from backend data
  useEffect(() => {
    const hasMessages = streamState?.messages && streamState.messages.size > 0;

    // Only sync when:
    // 1. We have a taskId
    // 2. We have subtasks
    // 3. The task has changed (different from last synced) OR messages are empty
    //    (force resync after clearAllStreams to fix double-click blank message bug)
    if (
      taskId &&
      subtasks &&
      subtasks.length > 0 &&
      (taskId !== lastSyncedTaskIdRef.current || !hasMessages)
    ) {
      console.log('[useUnifiedMessages] Syncing backend messages for task', taskId);
      syncBackendMessages(taskId, subtasks, {
        teamName: team?.name,
        isGroupChat,
        currentUserId: user?.id,
        currentUserName: user?.user_name,
      });
      lastSyncedTaskIdRef.current = taskId;
    }

    // Reset tracking when task is cleared
    if (!taskId) {
      lastSyncedTaskIdRef.current = undefined;
    }
  }, [
    taskId,
    subtasks,
    streamState,
    syncBackendMessages,
    team?.name,
    isGroupChat,
    user?.id,
    user?.user_name,
  ]);

  // Build unified message list from streamState.messages ONLY
  // NOTE: streamState is obtained outside useMemo to ensure proper reactivity
  // when streamStates changes in the context
  const result = useMemo<UseUnifiedMessagesResult>(() => {
    // If no taskId or no streamState, return empty result
    if (!taskId || !streamState?.messages) {
      return {
        messages: [],
        isStreaming: false,
        streamingSubtaskIds: [],
        hasPendingMessages: false,
        subtasksMap: new Map(),
        pendingMessages: [],
      };
    }

    const streamingSubtaskIds: number[] = [];
    let hasPendingMessages = false;
    const subtasksMap = new Map<number, { content: string; isStreaming: boolean }>();
    const pendingMessages: Array<{
      id: string;
      content: string;
      timestamp: number;
      attachment?: Attachment;
    }> = [];

    // Convert streamState.messages to DisplayMessage array
    const messages: DisplayMessage[] = [];

    for (const [, msg] of streamState.messages) {
      // Handle both singular 'attachment' (from pending messages) and plural 'attachments' (from backend)
      // When user sends a message with attachment, it's stored in 'attachment' field
      // When synced from backend, it's in 'attachments' array
      let attachments: Attachment[] | undefined;
      if (msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        attachments = msg.attachments as Attachment[];
      } else if (msg.attachment) {
        // Convert singular attachment to array for consistent rendering
        attachments = [msg.attachment as Attachment];
      }

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
        botName: msg.botName || team?.name,
        senderUserName: msg.senderUserName,
        senderUserId: msg.senderUserId,
        shouldShowSender: msg.shouldShowSender || (isGroupChat && msg.type === 'user'),
        subtaskStatus: msg.subtaskStatus,
        // Get thinking from result field (for executor tasks)
        thinking: msg.result?.thinking,
        // Include full result object (contains shell_type and other metadata)
        result: msg.result,
        isCurrentUser: msg.type === 'user' && (msg.senderUserId === user?.id || !msg.senderUserId),
        showSender: isGroupChat && msg.type === 'user',
      };

      messages.push(displayMsg);

      // Track pending user messages
      if (msg.type === 'user' && msg.status === 'pending') {
        hasPendingMessages = true;
        pendingMessages.push({
          id: msg.id,
          content: msg.content,
          timestamp: msg.timestamp,
          attachment: msg.attachment as Attachment | undefined,
        });
      }

      // Track streaming AI messages
      if (msg.type === 'ai' && msg.status === 'streaming' && msg.subtaskId) {
        streamingSubtaskIds.push(msg.subtaskId);
        subtasksMap.set(msg.subtaskId, {
          content: msg.content,
          isStreaming: true,
        });
      }
    }

    // Sort messages by messageId (primary) and timestamp (secondary)
    // This matches backend sorting logic which uses message_id + created_at
    // Messages without messageId (e.g., pending messages) are sorted by timestamp only
    const sortedMessages = messages.sort((a, b) => {
      // If both have messageId, use it as primary sort key
      if (a.messageId !== undefined && b.messageId !== undefined) {
        if (a.messageId !== b.messageId) {
          return a.messageId - b.messageId;
        }
        // Same messageId, use timestamp as secondary sort key
        return a.timestamp - b.timestamp;
      }
      // If only one has messageId, the one with messageId comes first (it's from backend)
      if (a.messageId !== undefined) return -1;
      if (b.messageId !== undefined) return 1;
      // Neither has messageId (both pending), sort by timestamp
      return a.timestamp - b.timestamp;
    });

    return {
      messages: sortedMessages,
      // Compute isStreaming from messages - a task is streaming if any AI message has status='streaming'
      isStreaming: streamingSubtaskIds.length > 0 || computeIsStreaming(streamState?.messages),
      streamingSubtaskIds,
      hasPendingMessages,
      subtasksMap,
      pendingMessages,
    };
  }, [taskId, streamState, team?.name, isGroupChat, user?.id]);

  return result;
}

export default useUnifiedMessages;
