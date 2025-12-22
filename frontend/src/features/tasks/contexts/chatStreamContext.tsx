// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Global Chat Stream Context
 *
 * This context manages streaming chat state at the application level,
 * allowing streams to continue running in the background when users
 * switch between tasks. Each stream is associated with a specific taskId.
 *
 * Now uses WebSocket (Socket.IO) instead of SSE for real-time communication.
 *
 * Key Design: UNIFIED MESSAGE LIST
 * All messages (user pending, user confirmed, AI streaming, AI completed) are stored
 * in a single `messages` Map. Each message maintains its own state independently.
 * This prevents state mixing issues when sending follow-up messages.
 *
 * State Flow:
 * 1. Send message -> Add user message with status='pending' to messages Map
 * 2. chat:start -> Add AI message with status='streaming' to messages Map
 * 3. chat:chunk -> Update AI message content in messages Map
 * 4. chat:done -> Update AI message status to 'completed' in messages Map
 *
 * NO REFRESH needed during the entire flow - all state changes are driven by
 * WebSocket events and local state updates.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  ReactNode,
} from 'react';
import { useSocket, ChatEventHandlers } from '@/contexts/SocketContext';
import {
  ChatSendPayload,
  ChatStartPayload,
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatCancelledPayload,
  ChatMessagePayload,
} from '@/types/socket';
import type { TaskDetailSubtask, Team } from '@/types/api';

/**
 * Message type enum
 */
export type MessageType = 'user' | 'ai';

/**
 * Message status enum
 */
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'error';

/**
 * Unified message state structure
 * All messages (user pending, user confirmed, AI streaming, AI completed) use this structure
 */
export interface UnifiedMessage {
  /** Unique ID for this message */
  id: string;
  /** Message type: user or ai */
  type: MessageType;
  /** Message status */
  status: MessageStatus;
  /** Message content */
  content: string;
  /** Attachment if any (for pending messages) */
  attachment?: unknown;
  /** Attachments array (for confirmed messages) */
  attachments?: unknown[];
  /** Timestamp when message was created */
  timestamp: number;
  /** Subtask ID from backend (set when confirmed) */
  subtaskId?: number;
  /** Message ID from backend for ordering (primary sort key) */
  messageId?: number;
  /** Error message if status is 'error' */
  error?: string;
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
  /** Full result data from backend (for executor tasks) */
  result?: {
    value?: string;
    thinking?: unknown[];
    workbench?: Record<string, unknown>;
  };
}

/**
 * State for a single streaming task
 *
 * Key design: All messages (user and AI) are stored in a single unified messages Map.
 * Each message has its own state (pending/streaming/completed/error) and content.
 * This allows proper isolation between messages and prevents state mixing issues.
 *
 * IMPORTANT: `isStreaming` is now computed from messages, not stored independently.
 * A task is streaming if any AI message has status='streaming'.
 */
interface StreamState {
  /** Whether stop operation is in progress */
  isStopping: boolean;
  /** Error if any */
  error: Error | null;
  /**
   * Unified message list - contains ALL messages (user pending, user confirmed, AI streaming, AI completed)
   * Key is a unique message ID (format: "user-{timestamp}-{random}" for user, "ai-{subtaskId}" for AI)
   * Messages are ordered by timestamp
   */
  messages: Map<string, UnifiedMessage>;
  /** Current AI response subtask ID (set when chat:start received) */
  subtaskId: number | null;
}

/**
 * Helper function to compute isStreaming from messages
 * A task is streaming if any AI message has status='streaming'
 * Exported for use in components that need to compute streaming state from messages
 */
export function computeIsStreaming(messages: Map<string, UnifiedMessage> | undefined): boolean {
  if (!messages) return false;
  for (const msg of messages.values()) {
    if (msg.type === 'ai' && msg.status === 'streaming') {
      return true;
    }
  }
  return false;
}
type StreamStateMap = Map<number, StreamState>;

/**
 * Request parameters for sending a chat message
 */
export interface ChatMessageRequest {
  /** User message */
  message: string;
  /** Team ID */
  team_id: number;
  /** Task ID for multi-turn conversations (optional) */
  task_id?: number;
  /** Custom title for new tasks (optional) */
  title?: string;
  /** Model ID override (optional) */
  model_id?: string;
  /** Force override bot's default model */
  force_override_bot_model?: boolean;
  /** Attachment ID for file upload (optional) */
  attachment_id?: number;
  /** Enable web search for this message */
  enable_web_search?: boolean;
  /** Search engine to use (when web search is enabled) */
  search_engine?: string;
  /** Enable clarification mode for this message */
  enable_clarification?: boolean;
  /** Mark this as a group chat task */
  is_group_chat?: boolean;
  // Repository info for code tasks
  git_url?: string;
  git_repo?: string;
  git_repo_id?: number;
  git_domain?: string;
  branch_name?: string;
  task_type?: 'chat' | 'code';
}

/**
 * Options for syncing backend messages
 */
interface SyncBackendMessagesOptions {
  /** Team name for display */
  teamName?: string;
  /** Whether this is a group chat */
  isGroupChat?: boolean;
  /** Current user ID for alignment */
  currentUserId?: number;
  /** Current user name for display (fallback when sender_user_name is empty) */
  currentUserName?: string;
}

/**
 * Context type for chat stream management
 */
interface ChatStreamContextType {
  /** Get stream state for a specific task */
  getStreamState: (taskId: number) => StreamState | undefined;
  /** Check if a task is currently streaming */
  isTaskStreaming: (taskId: number) => boolean;
  /** Get all currently streaming task IDs */
  getStreamingTaskIds: () => number[];
  /** Send a chat message (returns immediately after message is saved) */
  sendMessage: (
    request: ChatMessageRequest,
    options?: {
      pendingUserMessage?: string;
      pendingAttachment?: unknown;
      /** Callback when AI response completes (chat:done event) */
      onAIComplete?: (taskId: number, subtaskId: number) => void;
      onError?: (error: Error) => void;
      /** Callback when task ID is resolved (for new tasks) */
      onTaskIdResolved?: (taskId: number) => void;
      /** Temporary task ID for immediate UI feedback (for new tasks) */
      immediateTaskId?: number;
      /** Callback when user message is sent successfully (before AI response) */
      onMessageSent?: (taskId: number, subtaskId: number) => void;
      /** Current user ID for group chat sender info */
      currentUserId?: number;
      /** Current user name for group chat sender info */
      currentUserName?: string;
    }
  ) => Promise<number>;
  /**
   * Stop the stream for a specific task
   * @param taskId - Task ID
   * @param backupSubtasks - Optional backup subtasks from selectedTaskDetail, used to find running ASSISTANT subtask when chat:start hasn't been received
   * @param team - Optional team info for fallback shell_type when subtask bots are empty
   */
  stopStream: (taskId: number, backupSubtasks?: TaskDetailSubtask[], team?: Team) => Promise<void>;
  /** Reset stream state for a specific task */
  resetStream: (taskId: number) => void;
  /** Clear all stream states */
  clearAllStreams: () => void;
  /** Resume stream for a task (after page refresh) */
  resumeStream: (
    taskId: number,
    options?: {
      onComplete?: (taskId: number, subtaskId: number) => void;
      onError?: (error: Error) => void;
    }
  ) => Promise<boolean>;
  /** Sync backend subtasks to unified messages Map */
  syncBackendMessages: (
    taskId: number,
    subtasks: TaskDetailSubtask[],
    options?: SyncBackendMessagesOptions
  ) => void;
  /** Version number that increments when clearAllStreams is called */
  clearVersion: number;
}

// Export the context for components that need optional access (e.g., ClarificationForm)
export const ChatStreamContext = createContext<ChatStreamContextType | undefined>(undefined);

/**
 * Default stream state
 */
const defaultStreamState: StreamState = {
  isStopping: false,
  error: null,
  messages: new Map(),
  subtaskId: null,
};

/**
 * Generate a unique ID for messages
 * Format: "user-{timestamp}-{random}" for user messages, "ai-{subtaskId}" for AI messages
 */
function generateMessageId(type: 'user' | 'ai', subtaskId?: number): string {
  if (type === 'ai' && subtaskId) {
    return `ai-${subtaskId}`;
  }
  return `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Provider component for chat stream context
 */
export function ChatStreamProvider({ children }: { children: ReactNode }) {
  // Use state to trigger re-renders when stream states change
  const [streamStates, setStreamStates] = useState<StreamStateMap>(new Map());
  // Version number that increments when clearAllStreams is called
  // Components can watch this to reset their local state
  const [clearVersion, setClearVersion] = useState(0);

  // Get socket context
  const { isConnected, sendChatMessage, cancelChatStream, registerChatHandlers, joinTask } =
    useSocket();

  // Refs for callbacks (don't need to trigger re-renders)
  const callbacksRef = useRef<
    Map<
      number,
      {
        onAIComplete?: (taskId: number, subtaskId: number) => void;
        onError?: (error: Error) => void;
        onTaskIdResolved?: (taskId: number) => void;
        onMessageSent?: (taskId: number, subtaskId: number) => void;
      }
    >
  >(new Map());
  // Ref to track temporary task ID to real task ID mapping
  const tempToRealTaskIdRef = useRef<Map<number, number>>(new Map());
  // Ref to track which subtask belongs to which task
  const subtaskToTaskRef = useRef<Map<number, number>>(new Map());

  /**
   * Get stream state for a specific task
   */
  const getStreamState = useCallback(
    (taskId: number): StreamState | undefined => {
      return streamStates.get(taskId);
    },
    [streamStates]
  );

  /**
   * Check if a task is currently streaming
   * Computed from messages - a task is streaming if any AI message has status='streaming'
   */
  const isTaskStreaming = useCallback(
    (taskId: number): boolean => {
      const state = streamStates.get(taskId);
      if (!state) return false;
      return computeIsStreaming(state.messages);
    },
    [streamStates]
  );

  /**
   * Get all currently streaming task IDs
   * Computed from messages - a task is streaming if any AI message has status='streaming'
   */
  const getStreamingTaskIds = useCallback((): number[] => {
    const ids: number[] = [];
    streamStates.forEach((state, taskId) => {
      if (computeIsStreaming(state.messages)) {
        ids.push(taskId);
      }
    });
    return ids;
  }, [streamStates]);

  /**
   * Helper function to log messages Map state
   */
  const logMessagesState = (
    action: string,
    taskId: number,
    messages: Map<string, UnifiedMessage>
  ) => {
    const msgList = Array.from(messages.values()).map(m => ({
      id: m.id,
      type: m.type,
      status: m.status,
      subtaskId: m.subtaskId,
      contentLen: m.content?.length || 0,
    }));
    console.log(`[ChatStreamContext][${action}] taskId=${taskId}, messages:`, msgList);
  };

  /**
   * Handle chat:start event from WebSocket
   * This indicates AI has started generating response
   * Creates a new AI message in the unified messages Map
   */
  const handleChatStart = useCallback((data: ChatStartPayload) => {
    const { task_id, subtask_id } = data;

    // Track subtask to task mapping
    if (subtask_id) {
      subtaskToTaskRef.current.set(subtask_id, task_id);
    }

    const aiMessageId = generateMessageId('ai', subtask_id);

    setStreamStates(prev => {
      const newMap = new Map(prev);

      // Check if we already have state for this task_id
      if (newMap.has(task_id)) {
        const currentState = newMap.get(task_id)!;

        // Add new AI message to unified messages Map
        const newMessages = new Map(currentState.messages);
        newMessages.set(aiMessageId, {
          id: aiMessageId,
          type: 'ai',
          status: 'streaming',
          content: '',
          timestamp: Date.now(),
          subtaskId: subtask_id,
        });

        console.log('[ChatStreamContext][chat:start] Added AI message to existing task', {
          taskId: task_id,
          aiMessageId,
          subtaskId: subtask_id,
        });
        logMessagesState('chat:start', task_id, newMessages);

        newMap.set(task_id, {
          ...currentState,
          subtaskId: subtask_id,
          messages: newMessages,
        });
        return newMap;
      }

      // Look for temporary task ID (negative number) that might need to be migrated
      // This happens when chat:start arrives before sendChatMessage response
      for (const [tempId, state] of newMap.entries()) {
        if (tempId < 0 && !state.subtaskId) {
          // Found a temporary state without AI subtask ID
          // This is likely the one waiting for this chat:start

          // Add new AI message to unified messages Map
          const newMessages = new Map(state.messages);
          newMessages.set(aiMessageId, {
            id: aiMessageId,
            type: 'ai',
            status: 'streaming',
            content: '',
            timestamp: Date.now(),
            subtaskId: subtask_id,
          });

          // Move state from temp ID to real ID
          newMap.delete(tempId);
          newMap.set(task_id, {
            ...state,
            subtaskId: subtask_id,
            messages: newMessages,
          });

          // Update callbacks
          const callbacks = callbacksRef.current.get(tempId);
          if (callbacks) {
            callbacksRef.current.delete(tempId);
            callbacksRef.current.set(task_id, callbacks);
            // Notify about resolved task ID
            callbacks.onTaskIdResolved?.(task_id);
          }

          // Update temp to real mapping
          tempToRealTaskIdRef.current.set(tempId, task_id);

          return newMap;
        }
      }

      // No existing state found, create new one with initial AI message
      const newMessages = new Map<string, UnifiedMessage>();
      newMessages.set(aiMessageId, {
        id: aiMessageId,
        type: 'ai',
        status: 'streaming',
        content: '',
        timestamp: Date.now(),
        subtaskId: subtask_id,
      });

      console.log('[ChatStreamContext][chat:start] Created new task state', {
        taskId: task_id,
        aiMessageId,
        subtaskId: subtask_id,
      });
      logMessagesState('chat:start (new)', task_id, newMessages);

      newMap.set(task_id, {
        ...defaultStreamState,
        subtaskId: subtask_id,
        messages: newMessages,
      });
      return newMap;
    });
  }, []);

  /**
   * Handle chat:chunk event from WebSocket
   * Accumulate streaming content for the specific AI message in the unified messages Map
   * For executor tasks, also update the result field (contains thinking, workbench)
   */
  const handleChatChunk = useCallback((data: ChatChunkPayload) => {
    const { subtask_id, content, result } = data;

    // Find task ID from subtask
    let taskId = subtaskToTaskRef.current.get(subtask_id);

    // If taskId is a temporary ID (negative), resolve it to the real ID
    if (taskId && taskId < 0) {
      const realId = tempToRealTaskIdRef.current.get(taskId);

      if (realId) {
        taskId = realId;
        // Update the mapping to use the real ID
        subtaskToTaskRef.current.set(subtask_id, realId);
      }
    }

    if (!taskId) {
      console.warn('[ChatStreamContext] Received chunk for unknown subtask:', subtask_id);
      return;
    }

    const aiMessageId = generateMessageId('ai', subtask_id);

    // Update the specific AI message's content in the unified messages Map
    setStreamStates(prev => {
      const newMap = new Map(prev);
      const currentState = newMap.get(taskId);
      if (!currentState) return prev;

      // Update unified messages Map
      const newMessages = new Map(currentState.messages);
      const existingMessage = newMessages.get(aiMessageId);
      if (existingMessage) {
        // For executor tasks, result contains full data (thinking, workbench)
        // Content is accumulated, but result is replaced with latest
        const updatedMessage: UnifiedMessage = {
          ...existingMessage,
          content: existingMessage.content + content,
        };
        // If result is provided (executor tasks), update it
        if (result) {
          updatedMessage.result = result as UnifiedMessage['result'];
        }
        newMessages.set(aiMessageId, updatedMessage);
      }

      newMap.set(taskId, {
        ...currentState,
        messages: newMessages,
      });
      return newMap;
    });
  }, []);

  /**
   * Handle chat:done event from WebSocket
   * AI response is complete - mark the specific AI message as completed but KEEP its content
   * NO REFRESH needed - the UI will display the content from messages Map
   */
  const handleChatDone = useCallback((data: ChatDonePayload) => {
    const { task_id: eventTaskId, subtask_id, result, message_id } = data;

    // Find task ID from subtask mapping, or use task_id from event (for group chat members)
    let taskId = subtaskToTaskRef.current.get(subtask_id);

    // If taskId is a temporary ID (negative), resolve it to the real ID
    if (taskId && taskId < 0) {
      const realId = tempToRealTaskIdRef.current.get(taskId);
      if (realId) {
        taskId = realId;
        // Update the mapping to use the real ID
        subtaskToTaskRef.current.set(subtask_id, realId);
      } else {
        console.warn('[ChatStreamContext][chat:done] Temporary ID found but no real ID mapping', {
          tempId: taskId,
          subtask_id,
        });
      }
    }

    if (!taskId && eventTaskId) {
      // For group chat members who may not have received chat:start,
      // or when the subtask mapping is missing, use task_id from the event
      taskId = eventTaskId;
      subtaskToTaskRef.current.set(subtask_id, taskId);
    }
    if (!taskId) {
      console.warn('[ChatStreamContext][chat:done] Unknown subtask:', subtask_id);
      return;
    }

    // Get final content - prefer result.value if available
    const finalContent = (result?.value as string) || '';

    const aiMessageId = generateMessageId('ai', subtask_id);

    // Update the specific AI message's state - mark as completed but KEEP the content
    setStreamStates(prev => {
      const newMap = new Map(prev);
      const currentState = newMap.get(taskId);

      if (!currentState) {
        return prev;
      }

      // Update unified messages Map
      const newMessages = new Map(currentState.messages);
      const existingMessage = newMessages.get(aiMessageId);

      if (existingMessage) {
        newMessages.set(aiMessageId, {
          ...existingMessage,
          status: 'completed',
          content: finalContent || existingMessage.content,
          // Set messageId from backend for proper sorting
          messageId: message_id,
        });
      } else {
        console.warn('[ChatStreamContext][chat:done] AI message not found, cannot update status', {
          taskId,
          aiMessageId,
          subtask_id,
          availableMessages: Array.from(newMessages.keys()),
        });
      }

      logMessagesState('chat:done', taskId, newMessages);

      newMap.set(taskId, {
        ...currentState,
        isStopping: false,
        messages: newMessages,
      });
      return newMap;
    });

    // Call AI completion callback (for any cleanup needed by ChatArea)
    const callbacks = callbacksRef.current.get(taskId);
    callbacks?.onAIComplete?.(taskId, subtask_id);
  }, []);

  /**
   * Handle chat:error event from WebSocket
   */
  const handleChatError = useCallback((data: ChatErrorPayload) => {
    const { subtask_id, error } = data;

    // Find task ID from subtask
    let taskId = subtaskToTaskRef.current.get(subtask_id);

    // If taskId is a temporary ID (negative), resolve it to the real ID
    if (taskId && taskId < 0) {
      const realId = tempToRealTaskIdRef.current.get(taskId);
      if (realId) {
        taskId = realId;
        // Update the mapping to use the real ID
        subtaskToTaskRef.current.set(subtask_id, realId);
      }
    }

    if (!taskId) {
      console.warn('[ChatStreamContext] Received error for unknown subtask:', subtask_id);
      return;
    }

    const errorObj = new Error(error);
    const aiMessageId = generateMessageId('ai', subtask_id);

    // Update state - mark AI message as error
    setStreamStates(prev => {
      const newMap = new Map(prev);
      const currentState = newMap.get(taskId);
      if (!currentState) return prev;

      // Update unified messages Map - mark AI message as error
      const newMessages = new Map(currentState.messages);
      const existingMessage = newMessages.get(aiMessageId);
      if (existingMessage) {
        newMessages.set(aiMessageId, {
          ...existingMessage,
          status: 'error',
          error: error,
        });
      }

      newMap.set(taskId, {
        ...currentState,
        isStopping: false,
        error: errorObj,
        messages: newMessages,
      });
      return newMap;
    });

    // Call error callback
    const callbacks = callbacksRef.current.get(taskId);
    callbacks?.onError?.(errorObj);

    console.error('[ChatStreamContext] chat:error received', {
      task_id: taskId,
      subtask_id,
      error,
    });
  }, []);
  /**
   * Handle chat:cancelled event from WebSocket
   */
  const handleChatCancelled = useCallback((data: ChatCancelledPayload) => {
    const { task_id: eventTaskId, subtask_id } = data;

    // Use task_id from event, or fallback to subtask mapping
    const taskId = eventTaskId || subtaskToTaskRef.current.get(subtask_id);

    if (!taskId) {
      console.warn('[ChatStreamContext] Received cancelled for unknown subtask:', subtask_id);
      return;
    }

    // Track subtask to task mapping for future reference
    if (subtask_id && taskId) {
      subtaskToTaskRef.current.set(subtask_id, taskId);
    }

    const aiMessageId = generateMessageId('ai', subtask_id);

    // Update state - mark AI message as completed (cancelled is treated as completed)
    setStreamStates(prev => {
      const newMap = new Map(prev);
      const currentState = newMap.get(taskId);
      if (!currentState) return prev;

      // Update unified messages Map - mark AI message as completed
      const newMessages = new Map(currentState.messages);
      const existingMessage = newMessages.get(aiMessageId);
      if (existingMessage) {
        newMessages.set(aiMessageId, {
          ...existingMessage,
          status: 'completed',
        });
      }

      newMap.set(taskId, {
        ...currentState,
        isStopping: false,
        messages: newMessages,
      });
      return newMap;
    });

    // Call AI completion callback (cancelled is treated as completed)
    const callbacks = callbacksRef.current.get(taskId);
    callbacks?.onAIComplete?.(taskId, subtask_id);

    console.log('[ChatStreamContext] chat:cancelled received', { task_id: taskId, subtask_id });
  }, []);

  /**
   * Handle chat:message event from WebSocket
   * This is triggered when another user sends a message in a group chat
   * Adds the message to the unified messages Map for real-time display
   */
  const handleChatMessage = useCallback((data: ChatMessagePayload) => {
    const { task_id, subtask_id, message_id, role, content, sender, created_at, attachments } =
      data;

    console.log('[ChatStreamContext][chat:message] Received', {
      task_id,
      subtask_id,
      message_id,
      role,
      sender,
      contentLen: content?.length || 0,
      attachmentsCount: attachments?.length || 0,
    });

    // Generate message ID based on role
    const isUserMessage = role === 'user' || role?.toUpperCase() === 'USER';
    const msgId = isUserMessage ? `user-backend-${subtask_id}` : `ai-${subtask_id}`;

    // Track subtask to task mapping
    subtaskToTaskRef.current.set(subtask_id, task_id);

    // Add the message to the unified messages Map
    setStreamStates(prev => {
      const newMap = new Map(prev);
      const currentState = newMap.get(task_id) || { ...defaultStreamState };

      // Check if message already exists (avoid duplicates)
      if (currentState.messages.has(msgId)) {
        console.log('[ChatStreamContext][chat:message] Message already exists, skipping', {
          msgId,
        });
        return prev;
      }

      const newMessages = new Map(currentState.messages);

      const newMessage: UnifiedMessage = {
        id: msgId,
        type: isUserMessage ? 'user' : 'ai',
        status: 'completed',
        content: content || '',
        timestamp: created_at ? new Date(created_at).getTime() : Date.now(),
        subtaskId: subtask_id,
        messageId: message_id,
        senderUserName: sender?.user_name,
        senderUserId: sender?.user_id,
        shouldShowSender: isUserMessage, // Show sender for user messages in group chat
        attachments: attachments,
      };

      newMessages.set(msgId, newMessage);

      console.log('[ChatStreamContext][chat:message] Added message to task', {
        taskId: task_id,
        msgId,
        messageId: message_id,
        senderUserName: sender?.user_name,
        attachmentsCount: attachments?.length || 0,
      });
      logMessagesState('chat:message', task_id, newMessages);

      newMap.set(task_id, {
        ...currentState,
        messages: newMessages,
      });
      return newMap;
    });
  }, []);

  // Register WebSocket event handlers
  useEffect(() => {
    const handlers: ChatEventHandlers = {
      onChatStart: handleChatStart,
      onChatChunk: handleChatChunk,
      onChatDone: handleChatDone,
      onChatError: handleChatError,
      onChatCancelled: handleChatCancelled,
      onChatMessage: handleChatMessage,
    };

    const cleanup = registerChatHandlers(handlers);
    return cleanup;
  }, [
    registerChatHandlers,
    handleChatStart,
    handleChatChunk,
    handleChatDone,
    handleChatError,
    handleChatCancelled,
    handleChatMessage,
  ]);

  /**
   * Send a chat message via WebSocket
   *
   * Flow:
   * 1. Add user message with status='pending' to messages Map immediately
   * 2. Send message via WebSocket
   * 3. On success: call onMessageSent callback (NO REFRESH)
   * 4. Wait for chat:start -> chat:chunk -> chat:done events
   *
   * NO REFRESH during the entire flow - all UI updates are driven by state changes
   */
  const sendMessage = useCallback(
    async (
      request: ChatMessageRequest,
      options?: {
        pendingUserMessage?: string;
        pendingAttachment?: unknown;
        /** Callback when AI response completes (chat:done event) */
        onAIComplete?: (taskId: number, subtaskId: number) => void;
        onError?: (error: Error) => void;
        onTaskIdResolved?: (taskId: number) => void;
        immediateTaskId?: number;
        /** Callback when user message is sent successfully (before AI response) */
        onMessageSent?: (taskId: number, subtaskId: number) => void;
        /** Current user ID for group chat sender info */
        currentUserId?: number;
        /** Current user name for group chat sender info */
        currentUserName?: string;
      }
    ): Promise<number> => {
      console.log('[ChatStreamContext] sendMessage called', {
        isConnected,
        teamId: request.team_id,
        taskId: request.task_id,
        messagePreview: request.message?.substring(0, 50),
      });

      // Check WebSocket connection
      if (!isConnected) {
        console.error('[ChatStreamContext] WebSocket not connected, isConnected:', isConnected);
        const error = new Error('WebSocket not connected');
        options?.onError?.(error);
        throw error;
      }

      // Use provided immediateTaskId or generate one for new tasks
      const immediateTaskId = options?.immediateTaskId || request.task_id || -Date.now();

      // Store callbacks for AI response events (chat:start, chat:done, etc.)
      callbacksRef.current.set(immediateTaskId, {
        onAIComplete: options?.onAIComplete,
        onError: options?.onError,
        onTaskIdResolved: options?.onTaskIdResolved,
        onMessageSent: options?.onMessageSent,
      });

      // Create a new user message for this send operation
      const userMessageId = generateMessageId('user');
      const userMessage: UnifiedMessage = {
        id: userMessageId,
        type: 'user',
        status: 'pending',
        content: options?.pendingUserMessage || request.message,
        attachment: options?.pendingAttachment,
        timestamp: Date.now(),
        // Add sender info for group chat
        senderUserName: options?.currentUserName,
        senderUserId: options?.currentUserId,
        shouldShowSender: request.is_group_chat,
      };

      // Add user message to the unified messages Map immediately
      setStreamStates(prev => {
        const newMap = new Map(prev);
        const currentState = newMap.get(immediateTaskId) || { ...defaultStreamState };

        // Add new user message to existing messages
        const newMessages = new Map(currentState.messages);
        newMessages.set(userMessageId, userMessage);

        newMap.set(immediateTaskId, {
          ...currentState,
          isStopping: false,
          error: null,
          subtaskId: null,
          messages: newMessages,
        });
        return newMap;
      });

      // Convert request to WebSocket payload
      const payload: ChatSendPayload = {
        task_id: request.task_id,
        team_id: request.team_id,
        message: request.message,
        title: request.title,
        attachment_id: request.attachment_id,
        enable_web_search: request.enable_web_search,
        search_engine: request.search_engine,
        enable_clarification: request.enable_clarification,
        force_override_bot_model: request.model_id,
        force_override_bot_model_type: request.force_override_bot_model ? 'user' : undefined,
        is_group_chat: request.is_group_chat,
        // Repository info for code tasks
        git_url: request.git_url,
        git_repo: request.git_repo,
        git_repo_id: request.git_repo_id,
        git_domain: request.git_domain,
        branch_name: request.branch_name,
        task_type: request.task_type,
      };

      try {
        // Send message via WebSocket
        const response = await sendChatMessage(payload);

        // Handle undefined or error response
        if (!response) {
          const error = new Error('Failed to send message: no response from server');
          // Update user message status to error
          setStreamStates(prev => {
            const newMap = new Map(prev);
            const currentState = newMap.get(immediateTaskId);
            if (currentState) {
              const newMessages = new Map(currentState.messages);
              const msg = newMessages.get(userMessageId);
              if (msg) {
                newMessages.set(userMessageId, { ...msg, status: 'error', error: error.message });
              }
              newMap.set(immediateTaskId, { ...currentState, error, messages: newMessages });
            }
            return newMap;
          });
          options?.onError?.(error);
          throw error;
        }

        if (response.error) {
          const error = new Error(response.error);
          // Update user message status to error
          setStreamStates(prev => {
            const newMap = new Map(prev);
            const currentState = newMap.get(immediateTaskId);
            if (currentState) {
              const newMessages = new Map(currentState.messages);
              const msg = newMessages.get(userMessageId);
              if (msg) {
                newMessages.set(userMessageId, { ...msg, status: 'error', error: response.error });
              }
              newMap.set(immediateTaskId, { ...currentState, error, messages: newMessages });
            }
            return newMap;
          });
          options?.onError?.(error);
          throw error;
        }

        const realTaskId = response.task_id || immediateTaskId;
        const subtaskId = response.subtask_id;
        const messageId = response.message_id;

        // Update user message status to completed and set subtaskId and messageId
        setStreamStates(prev => {
          const newMap = new Map(prev);
          const currentState = newMap.get(immediateTaskId);
          if (currentState) {
            const newMessages = new Map(currentState.messages);
            const msg = newMessages.get(userMessageId);
            if (msg) {
              newMessages.set(userMessageId, {
                ...msg,
                status: 'completed',
                subtaskId,
                messageId,
              });
            }

            // If we got a real task ID different from immediate, migrate state
            if (realTaskId !== immediateTaskId && realTaskId > 0) {
              newMap.delete(immediateTaskId);
              newMap.set(realTaskId, { ...currentState, messages: newMessages });

              // Update callbacks
              const callbacks = callbacksRef.current.get(immediateTaskId);
              if (callbacks) {
                callbacksRef.current.delete(immediateTaskId);
                callbacksRef.current.set(realTaskId, callbacks);
              }

              // Update temp to real mapping
              tempToRealTaskIdRef.current.set(immediateTaskId, realTaskId);
            } else {
              newMap.set(immediateTaskId, { ...currentState, messages: newMessages });
            }
          }
          return newMap;
        });

        // Notify about resolved task ID
        if (realTaskId !== immediateTaskId && realTaskId > 0) {
          options?.onTaskIdResolved?.(realTaskId);
          // Join the task room for receiving AI response events
          await joinTask(realTaskId);
        } else if (request.task_id && request.task_id > 0) {
          // Existing task, join the room for receiving AI response events
          await joinTask(request.task_id);
        }

        // Track subtask to task mapping (this is the user's subtask)
        if (subtaskId) {
          subtaskToTaskRef.current.set(subtaskId, realTaskId);
        }

        console.log('[ChatStreamContext] Message sent successfully via WebSocket', {
          immediateTaskId,
          realTaskId,
          subtaskId,
        });

        // Message sent successfully - call onMessageSent callback
        // NO REFRESH - the UI will display user message from messages Map
        const finalTaskId = realTaskId > 0 ? realTaskId : immediateTaskId;
        options?.onMessageSent?.(finalTaskId, subtaskId || 0);

        return realTaskId;
      } catch (error) {
        // Update user message status to error
        setStreamStates(prev => {
          const newMap = new Map(prev);
          const currentState = newMap.get(immediateTaskId);
          if (currentState) {
            const newMessages = new Map(currentState.messages);
            const msg = newMessages.get(userMessageId);
            if (msg) {
              newMessages.set(userMessageId, {
                ...msg,
                status: 'error',
                error: (error as Error).message,
              });
            }
            newMap.set(immediateTaskId, {
              ...currentState,
              error: error as Error,
              messages: newMessages,
            });
          }
          return newMap;
        });
        throw error;
      }
    },
    [isConnected, sendChatMessage, joinTask]
  );

  /**
   * Stop the stream for a specific task using WebSocket
   * If subtaskId is not found in stream state, search in backend subtasks
   */
  const stopStream = useCallback(
    async (taskId: number, backupSubtasks?: TaskDetailSubtask[], team?: Team): Promise<void> => {
      const state = streamStates.get(taskId);
      const isStreaming = computeIsStreaming(state?.messages);

      // Check if streaming by computing from messages
      if (!state || !isStreaming) {
        return;
      }

      // Set stopping state
      setStreamStates(prev => {
        const newMap = new Map(prev);
        const currentState = newMap.get(taskId);
        if (currentState) {
          newMap.set(taskId, { ...currentState, isStopping: true });
        }
        return newMap;
      });

      let subtaskId = state.subtaskId;
      let runningSubtask: TaskDetailSubtask | undefined;

      // If subtaskId is not available in stream state, try to find it from backend subtasks
      // This handles the case where chat:start hasn't been received yet (user clicks cancel very quickly)
      if (!subtaskId && backupSubtasks && backupSubtasks.length > 0) {
        // Find the last RUNNING ASSISTANT subtask
        runningSubtask = backupSubtasks
          .filter(st => st.role === 'ASSISTANT' && st.status === 'RUNNING')
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

        if (runningSubtask) {
          subtaskId = runningSubtask.id;
        }
      } else if (subtaskId && backupSubtasks) {
        // If we have subtaskId from state, find the corresponding subtask to get bot info
        runningSubtask = backupSubtasks.find(st => st.id === subtaskId);

        // If not found (subtask not yet in backupSubtasks after new message),
        // fallback to finding the latest RUNNING ASSISTANT subtask
        if (!runningSubtask) {
          runningSubtask = backupSubtasks
            .filter(st => st.role === 'ASSISTANT' && st.status === 'RUNNING')
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
        }
      }

      // Get current content from the AI message
      let partialContent = '';
      if (subtaskId) {
        const aiMessageId = generateMessageId('ai', subtaskId);
        const aiMessage = state.messages.get(aiMessageId);
        partialContent = aiMessage?.content || '';
      }

      // Get shell_type from the running subtask's first bot
      // Fallback to team's first bot shell_type or agent_type if subtask bots are empty
      let shellType = runningSubtask?.bots?.[0]?.shell_type;
      if (!shellType && team) {
        // Try team.bots[0].bot.shell_type first
        shellType = team.bots?.[0]?.bot?.shell_type;
        // If still not found, check team.agent_type (e.g., 'chat' -> 'Chat')
        if (!shellType && team.agent_type?.toLowerCase() === 'chat') {
          shellType = 'Chat';
        }
      }

      // Call backend to cancel via WebSocket
      if (subtaskId) {
        try {
          const result = await cancelChatStream(subtaskId, partialContent, shellType);

          if (result.error) {
            console.error('[ChatStreamContext] Failed to cancel stream:', result.error);
          }

          // Call onAIComplete callback
          const callbacks = callbacksRef.current.get(taskId);
          callbacks?.onAIComplete?.(taskId, subtaskId);
        } catch (error) {
          console.error('[ChatStreamContext] Exception during cancelChatStream:', error);
        }
      }

      // Update state - keep the partial content and mark AI message as completed
      setStreamStates(prev => {
        const newMap = new Map(prev);
        const currentState = newMap.get(taskId);
        if (currentState) {
          // Create a new messages map with AI message status updated to 'completed'
          const updatedMessages = new Map(currentState.messages);
          if (subtaskId) {
            const aiMessageId = generateMessageId('ai', subtaskId);
            const aiMessage = updatedMessages.get(aiMessageId);
            if (aiMessage && aiMessage.status === 'streaming') {
              updatedMessages.set(aiMessageId, {
                ...aiMessage,
                status: 'completed',
              });
            }
          }
          newMap.set(taskId, {
            ...currentState,
            isStopping: false,
            messages: updatedMessages,
          });
        }
        return newMap;
      });
    },
    [streamStates, cancelChatStream]
  );

  /**
   * Reset stream state for a specific task
   * Called when user switches to a different task or starts a new conversation
   */
  const resetStream = useCallback((taskId: number): void => {
    setStreamStates(prev => {
      const newMap = new Map(prev);
      newMap.delete(taskId);
      return newMap;
    });
    callbacksRef.current.delete(taskId);

    // Clean up subtask mappings for this task
    subtaskToTaskRef.current.forEach((tid, subtaskId) => {
      if (tid === taskId) {
        subtaskToTaskRef.current.delete(subtaskId);
      }
    });

    // Clean up temp to real task ID mapping
    tempToRealTaskIdRef.current.forEach((realId, tempId) => {
      if (realId === taskId || tempId === taskId) {
        tempToRealTaskIdRef.current.delete(tempId);
      }
    });
  }, []);

  /**
   * Clear all stream states (frontend only)
   *
   * This only clears the frontend state without cancelling the backend stream.
   * The backend will continue processing and save the result to the database.
   * Use stopStream() if you want to actually cancel the AI generation.
   */
  const clearAllStreams = useCallback((): void => {
    // Only clear frontend state, do NOT cancel backend streams
    // This allows AI to continue generating in the background when user switches tasks
    console.log(
      '[ChatStreamContext] Clearing all stream states (frontend only, backend continues)'
    );

    callbacksRef.current.clear();
    subtaskToTaskRef.current.clear();
    tempToRealTaskIdRef.current.clear();
    setStreamStates(new Map());
    // Increment clearVersion to notify components to reset their local state
    setClearVersion(v => v + 1);
  }, []);

  /**
   * Resume stream for a task (after page refresh)
   *
   * This function checks if there's an active streaming session for the task
   * and resumes receiving the stream if so.
   *
   * @param taskId - The task ID to resume streaming for
   * @param options - Optional callbacks for completion and error
   * @returns true if stream was resumed, false if no active stream
   */
  const resumeStream = useCallback(
    async (
      taskId: number,
      options?: {
        onComplete?: (taskId: number, subtaskId: number) => void;
        onError?: (error: Error) => void;
      }
    ): Promise<boolean> => {
      console.log('[ChatStreamContext] resumeStream called', { taskId, isConnected });

      // Check WebSocket connection
      if (!isConnected) {
        console.log('[ChatStreamContext] WebSocket not connected, cannot resume stream');
        return false;
      }

      // Check if already streaming for this task
      const existingState = streamStates.get(taskId);
      if (existingState && computeIsStreaming(existingState.messages)) {
        console.log('[ChatStreamContext] Already streaming for task', taskId);
        return true;
      }

      try {
        // Join task room and check for active streaming
        const response = await joinTask(taskId);

        if (response.error) {
          console.error('[ChatStreamContext] Failed to join task:', response.error);
          return false;
        }

        // Check if there's an active streaming session
        if (response.streaming) {
          const { subtask_id, cached_content } = response.streaming;

          console.log('[ChatStreamContext] Found active streaming session', {
            taskId,
            subtaskId: subtask_id,
            cachedContentLength: cached_content?.length || 0,
          });

          // Track subtask to task mapping
          subtaskToTaskRef.current.set(subtask_id, taskId);

          // Store callbacks
          if (options) {
            callbacksRef.current.set(taskId, {
              onAIComplete: options.onComplete,
              onError: options.onError,
            });
          }

          // Initialize stream state with cached content
          const initialContent = cached_content || '';
          const aiMessageId = generateMessageId('ai', subtask_id);

          setStreamStates(prev => {
            const newMap = new Map(prev);
            const currentState = newMap.get(taskId) || { ...defaultStreamState };

            const newMessages = new Map(currentState.messages);
            newMessages.set(aiMessageId, {
              id: aiMessageId,
              type: 'ai',
              status: 'streaming',
              content: initialContent,
              timestamp: Date.now(),
              subtaskId: subtask_id,
            });

            newMap.set(taskId, {
              ...currentState,
              isStopping: false,
              error: null,
              subtaskId: subtask_id,
              messages: newMessages,
            });
            return newMap;
          });

          console.log('[ChatStreamContext] Stream resumed successfully', {
            taskId,
            subtaskId: subtask_id,
            initialContentLength: initialContent.length,
          });

          return true;
        }

        console.log('[ChatStreamContext] No active streaming session for task', taskId);
        return false;
      } catch (error) {
        console.error('[ChatStreamContext] Error resuming stream:', error);
        options?.onError?.(error as Error);
        return false;
      }
    },
    [isConnected, streamStates, joinTask]
  );

  /**
   * Sync backend subtasks to unified messages Map
   *
   * This method converts backend TaskDetailSubtask[] to UnifiedMessage format
   * and merges them into the messages Map. It preserves any existing pending/streaming
   * messages that don't have a matching backend subtask yet.
   *
   * Key design:
   * - Backend subtasks are the source of truth for completed messages
   * - Pending/streaming messages from frontend are preserved until confirmed by backend
   * - Uses subtaskId as the unique key to avoid duplicates
   */
  const syncBackendMessages = useCallback(
    (taskId: number, subtasks: TaskDetailSubtask[], options?: SyncBackendMessagesOptions): void => {
      if (!subtasks || subtasks.length === 0) {
        return;
      }

      const { teamName, isGroupChat, currentUserId, currentUserName } = options || {};

      setStreamStates(prev => {
        const newMap = new Map(prev);
        const currentState = newMap.get(taskId) || { ...defaultStreamState };
        const newMessages = new Map<string, UnifiedMessage>();

        // First, add all backend subtasks as messages
        // Sort by message_id (primary) and created_at (secondary) to maintain correct order
        // This matches backend sorting logic
        const sortedSubtasks = [...subtasks].sort((a, b) => {
          // Primary sort by message_id
          if (a.message_id !== b.message_id) {
            return a.message_id - b.message_id;
          }
          // Secondary sort by created_at
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

        for (const subtask of sortedSubtasks) {
          // Backend returns role as uppercase 'USER' or 'ASSISTANT'
          const isUserMessage = subtask.role === 'USER' || subtask.role?.toUpperCase() === 'USER';
          const messageType: MessageType = isUserMessage ? 'user' : 'ai';

          // Generate message ID based on type and subtask ID
          const messageId = isUserMessage ? `user-backend-${subtask.id}` : `ai-${subtask.id}`;

          // Determine message status based on subtask status
          let status: MessageStatus = 'completed';
          if (subtask.status === 'RUNNING' || subtask.status === 'PENDING') {
            if (isUserMessage) {
              status = 'pending';
            } else {
              // For AI messages with RUNNING status:
              // Only set to 'streaming' if we already have this message in streaming state
              // (created by chat:start event). Otherwise, skip it - the message will be
              // created when chat:start event arrives.
              const existingMessage = currentState.messages.get(messageId);
              if (existingMessage && existingMessage.status === 'streaming') {
                status = 'streaming';
              } else {
                // Skip this AI message - it will be created by chat:start event
                continue;
              }
            }
          } else if (subtask.status === 'FAILED' || subtask.status === 'CANCELLED') {
            status = 'error';
          }

          // Get content from prompt (user) or result.value (AI)
          let content = '';
          if (isUserMessage) {
            content = subtask.prompt || '';
          } else {
            // AI message - get content from result.value
            const resultValue = subtask.result?.value;
            if (typeof resultValue === 'string') {
              content = resultValue;
            } else if (resultValue && typeof resultValue === 'object') {
              // Handle object result (e.g., workbench data)
              content = '';
            }
          }

          // Get bot name for AI messages
          let botName = teamName;
          if (!isUserMessage && subtask.bots && subtask.bots.length > 0) {
            botName = subtask.bots[0].name || teamName;
          }

          // Determine if we should show sender info (for group chat)
          const shouldShowSender = isGroupChat && isUserMessage;

          // For user messages, use sender_user_name from backend, or fallback to currentUserName if it's the current user
          const isCurrentUserMessage =
            isUserMessage &&
            (subtask.sender_user_id === currentUserId ||
              (!subtask.sender_user_id && currentUserId));
          const senderUserName =
            subtask.sender_user_name || (isCurrentUserMessage ? currentUserName : undefined);

          const message: UnifiedMessage = {
            id: messageId,
            type: messageType,
            status,
            content,
            timestamp: new Date(subtask.created_at).getTime(),
            subtaskId: subtask.id,
            messageId: subtask.message_id,
            attachments: subtask.attachments,
            botName,
            senderUserName,
            senderUserId: subtask.sender_user_id || (isUserMessage ? currentUserId : undefined),
            shouldShowSender,
            subtaskStatus: subtask.status,
            // Store full result for executor tasks (contains thinking, workbench)
            result: subtask.result as UnifiedMessage['result'],
            error: subtask.error_message || undefined,
          };

          newMessages.set(messageId, message);
        }
        // Then, preserve any pending/streaming messages from frontend that don't have
        // a matching backend subtask yet
        //
        // Build a set of backend user subtask IDs for deduplication
        // Note: We only check user messages because:
        // 1. Frontend user messages may have subtaskId set to AI's subtaskId (from response.subtask_id)
        // 2. We need to match by content/timestamp instead of subtaskId for user messages
        const backendUserSubtasks = subtasks.filter(
          s => s.role === 'USER' || s.role?.toUpperCase() === 'USER'
        );

        for (const [msgId, msg] of currentState.messages) {
          // Skip messages that were created from backend (they're already in newMessages)
          if (msgId.startsWith('user-backend-') || msgId.startsWith('ai-')) {
            continue;
          }

          // For frontend user messages, check if there's a matching backend user message
          // by comparing content (since subtaskId might be wrong - set to AI's subtaskId)
          if (msg.type === 'user') {
            const hasMatchingBackendMessage = backendUserSubtasks.some(
              s => s.prompt === msg.content
            );
            if (hasMatchingBackendMessage) {
              // This user message already exists in backend response, skip it
              continue;
            }
          }

          // Keep frontend messages that:
          // 1. Don't have a matching backend message yet
          // 2. Only keep if it's a pending or streaming message (not completed/error)
          if (msg.status === 'pending' || msg.status === 'streaming') {
            newMessages.set(msgId, msg);
          }
        }

        // Find current streaming subtask ID if any
        let currentSubtaskId: number | null = null;

        for (const msg of newMessages.values()) {
          if (msg.type === 'ai' && msg.status === 'streaming') {
            currentSubtaskId = msg.subtaskId || null;
            break;
          }
        }

        newMap.set(taskId, {
          ...currentState,
          subtaskId: currentSubtaskId,
          messages: newMessages,
        });

        return newMap;
      });
    },
    []
  );

  return (
    <ChatStreamContext.Provider
      value={{
        getStreamState,
        isTaskStreaming,
        getStreamingTaskIds,
        sendMessage,
        stopStream,
        resetStream,
        clearAllStreams,
        resumeStream,
        syncBackendMessages,
        clearVersion,
      }}
    >
      {children}
    </ChatStreamContext.Provider>
  );
}

/**
 * Hook to use chat stream context
 */
export function useChatStreamContext(): ChatStreamContextType {
  const context = useContext(ChatStreamContext);
  if (!context) {
    throw new Error('useChatStreamContext must be used within a ChatStreamProvider');
  }
  return context;
}

/**
 * Hook to get stream state for a specific task
 * Returns undefined if no stream exists for the task
 */
export function useTaskStreamState(taskId: number | undefined): StreamState | undefined {
  const { getStreamState } = useChatStreamContext();
  return taskId ? getStreamState(taskId) : undefined;
}
