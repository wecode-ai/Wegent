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
    shell_type?: string; // Shell type for frontend display (Chat, ClaudeCode, Agno, etc.)
    sources?: Array<{
      index: number;
      title: string;
      kb_id: number;
    }>;
  };
  /** Knowledge base source references (for RAG citations) */
  sources?: Array<{
    index: number;
    title: string;
    kb_id: number;
  }>;
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
  /** Attachment ID for file upload (optional, deprecated - use attachment_ids) */
  attachment_id?: number;
  /** Attachment IDs for multiple file uploads (optional) */
  attachment_ids?: number[];
  /** Enable web search for this message */
  enable_web_search?: boolean;
  /** Search engine to use (when web search is enabled) */
  search_engine?: string;
  /** Enable clarification mode for this message */
  enable_clarification?: boolean;
  /** Enable deep thinking mode for this message */
  enable_deep_thinking?: boolean;
  /** Mark this as a group chat task */
  is_group_chat?: boolean;
  /** Context items (knowledge bases, etc.) */
  contexts?: Array<{
    type: string;
    data: Record<string, unknown>;
  }>;
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
  /** Send a chat message (returns task ID) */
  sendMessage: (
    request: ChatMessageRequest,
    options?: {
      /** Local message ID from caller's message queue for precise update */
      localMessageId?: string;
      pendingUserMessage?: string;
      pendingAttachment?: unknown;
      pendingAttachments?: unknown[];
      onError?: (error: Error) => void;
      /** Callback when message is sent, passes back localMessageId for precise update */
      onMessageSent?: (localMessageId: string, taskId: number, subtaskId: number) => void;
      /** Temporary task ID for immediate UI feedback (for new tasks) */
      immediateTaskId?: number;
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
        onError?: (error: Error) => void;
        /** Local message ID for precise update callback */
        localMessageId?: string;
        onMessageSent?: (localMessageId: string, taskId: number, subtaskId: number) => void;
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
   * Handle chat:start event from WebSocket
   * This indicates AI has started generating response
   * Creates a new AI message in the unified messages Map
   */
  const handleChatStart = useCallback((data: ChatStartPayload) => {
    const { task_id, subtask_id, shell_type } = data;

    // DEBUG: Log the complete chat:start event payload
    console.log('[ChatStreamContext][chat:start] Received event:', {
      full_data: data,
      task_id,
      subtask_id,
      shell_type,
      has_shell_type: !!shell_type,
    });

    // Track subtask to task mapping
    if (subtask_id) {
      subtaskToTaskRef.current.set(subtask_id, task_id);
    }

    const aiMessageId = generateMessageId('ai', subtask_id);

    // Build initial result object with shell_type if available
    const initialResult = shell_type ? { shell_type } : undefined;
    console.log('[ChatStreamContext][chat:start] Initial result:', initialResult);

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
          result: initialResult, // Include shell_type from chat:start event
        });

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
            result: initialResult, // Include shell_type from chat:start event
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
    const { subtask_id, content, result, sources } = data;

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
        // For executor tasks, result contains full data (thinking, workbench, sources)
        // Content is accumulated, but result is replaced with latest
        const updatedMessage: UnifiedMessage = {
          ...existingMessage,
          content: existingMessage.content + content,
        };
        // If result is provided (executor tasks), update it
        if (result) {
          updatedMessage.result = result as UnifiedMessage['result'];
        }
        // If sources are provided directly (chat v2), update them
        if (sources) {
          updatedMessage.sources = sources;
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
    const { task_id: eventTaskId, subtask_id, result, message_id, sources } = data;

    // Find task ID from subtask mapping, or use task_id from event (for group chat members)
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
        // Check if this chat:done represents an error completion
        // Backend sends result.error when the message failed
        const hasError = result?.error !== undefined;
        const finalStatus = hasError ? 'error' : 'completed';
        const finalSubtaskStatus = hasError ? 'FAILED' : 'COMPLETED';

        // Only log when error status is being preserved (for debugging error flow)
        if (hasError) {
          console.log('[ChatStreamContext][chat:done] Preserving error status:', {
            subtaskId: subtask_id,
            errorMessage: result?.error,
          });
        }

        newMessages.set(aiMessageId, {
          ...existingMessage,
          status: finalStatus,
          subtaskStatus: finalSubtaskStatus, // Update subtaskStatus for ThinkingComponent
          content: finalContent || existingMessage.content,
          // Preserve error from chat:error if this is an error completion
          error: hasError ? (result.error as string) : existingMessage.error,
          // Set messageId from backend for proper sorting
          messageId: message_id,
          // Set sources if provided
          sources: sources || existingMessage.sources,
        });
      }

      newMap.set(taskId, {
        ...currentState,
        isStopping: false,
        messages: newMessages,
      });

      return newMap;
    });
    // Note: AI completion is handled by the streaming state change, no callback needed
  }, []);

  /**
   * Handle chat:error event from WebSocket
   */
  const handleChatError = useCallback((data: ChatErrorPayload) => {
    const eventId = Math.random().toString(36).substr(2, 9);
    console.log(
      `[ChatStreamContext][chat:error][${eventId}] RAW data received:`,
      data,
      typeof data
    );
    const { subtask_id, error, message_id } = data;

    console.log(`[ChatStreamContext][chat:error][${eventId}] Received error event:`, {
      subtask_id,
      error,
      message_id,
      hasMessageId: message_id !== undefined,
    });

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
        const updatedMessage = {
          ...existingMessage,
          status: 'error' as const,
          subtaskStatus: 'FAILED', // Update subtaskStatus for ThinkingComponent
          error: error,
          // Set messageId from backend for proper sorting, preserve existing if undefined
          messageId: message_id ?? existingMessage.messageId,
        };

        console.log('[ChatStreamContext][chat:error] Updating AI message:', {
          aiMessageId,
          subtask_id,
          oldMessageId: existingMessage.messageId,
          newMessageId: message_id,
          updatedMessage,
        });

        newMessages.set(aiMessageId, updatedMessage);
      } else {
        console.warn('[ChatStreamContext][chat:error] AI message not found:', {
          aiMessageId,
          subtask_id,
          availableMessages: Array.from(newMessages.keys()),
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

    console.error(`[ChatStreamContext][chat:error][${eventId}] processed`, {
      task_id: taskId,
      subtask_id,
      error,
      message_id,
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
          subtaskStatus: 'CANCELLED', // Update subtaskStatus for ThinkingComponent
        });
      }

      newMap.set(taskId, {
        ...currentState,
        isStopping: false,
        messages: newMessages,
      });
      return newMap;
    });
    // Note: AI completion is handled by the streaming state change, no callback needed
  }, []);

  /**
   * Handle chat:message event from WebSocket
   * This is triggered when another user sends a message in a group chat
   * Adds the message to the unified messages Map for real-time display
   */
  const handleChatMessage = useCallback((data: ChatMessagePayload) => {
    const { task_id, subtask_id, message_id, role, content, sender, created_at, attachments } =
      data;

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
        /** Local message ID from caller's message queue for precise update */
        localMessageId?: string;
        pendingUserMessage?: string;
        pendingAttachment?: unknown;
        pendingAttachments?: unknown[];
        onError?: (error: Error) => void;
        /** Callback when message is sent, passes back localMessageId for precise update */
        onMessageSent?: (localMessageId: string, taskId: number, subtaskId: number) => void;
        /** Temporary task ID for immediate UI feedback (for new tasks) */
        immediateTaskId?: number;
        /** Current user ID for group chat sender info */
        currentUserId?: number;
        /** Current user name for group chat sender info */
        currentUserName?: string;
      }
    ): Promise<number> => {
      // Check WebSocket connection
      if (!isConnected) {
        console.error('[ChatStreamContext] WebSocket not connected, isConnected:', isConnected);
        const error = new Error('WebSocket not connected');
        options?.onError?.(error);
        throw error;
      }

      // Use provided immediateTaskId or generate one for new tasks
      const immediateTaskId = options?.immediateTaskId || request.task_id || -Date.now();

      // Use provided localMessageId or generate one
      const userMessageId = options?.localMessageId || generateMessageId('user');

      // Store callbacks for error handling
      callbacksRef.current.set(immediateTaskId, {
        onError: options?.onError,
        localMessageId: userMessageId,
        onMessageSent: options?.onMessageSent,
      });
      const userMessage: UnifiedMessage = {
        id: userMessageId,
        type: 'user',
        status: 'pending',
        content: options?.pendingUserMessage || request.message,
        attachment: options?.pendingAttachment,
        attachments: options?.pendingAttachments,
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
        attachment_ids: request.attachment_ids,
        enable_web_search: request.enable_web_search,
        search_engine: request.search_engine,
        enable_clarification: request.enable_clarification,
        enable_deep_thinking: request.enable_deep_thinking,
        force_override_bot_model: request.model_id,
        force_override_bot_model_type: request.force_override_bot_model ? 'user' : undefined,
        is_group_chat: request.is_group_chat,
        contexts: request.contexts,
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

        // Update user message and migrate state in a SINGLE setStreamStates call
        // This prevents race conditions where the subtaskId update is lost during migration
        setStreamStates(prev => {
          const newMap = new Map(prev);

          // Check if state was already migrated by handleChatStart (race condition)
          // If chat:start arrived before sendChatMessage returned, state is already at realTaskId
          let currentState = newMap.get(immediateTaskId);
          let stateAlreadyMigrated = false;

          if (!currentState && realTaskId !== immediateTaskId && realTaskId > 0) {
            // State was already migrated to realTaskId by handleChatStart
            currentState = newMap.get(realTaskId);
            stateAlreadyMigrated = true;
          }

          if (!currentState) return prev;

          // Update user message with subtaskId and messageId
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

          const updatedState = { ...currentState, messages: newMessages };

          // If task ID changed (for new tasks) and not already migrated, migrate state
          if (realTaskId !== immediateTaskId && realTaskId > 0 && !stateAlreadyMigrated) {
            newMap.delete(immediateTaskId);
            newMap.set(realTaskId, updatedState);
          } else if (stateAlreadyMigrated) {
            // State was already migrated, just update at realTaskId
            newMap.set(realTaskId, updatedState);
          } else {
            newMap.set(immediateTaskId, updatedState);
          }

          return newMap;
        });

        // Update callbacks if task ID changed
        if (realTaskId !== immediateTaskId && realTaskId > 0) {
          const callbacks = callbacksRef.current.get(immediateTaskId);
          if (callbacks) {
            callbacksRef.current.delete(immediateTaskId);
            callbacksRef.current.set(realTaskId, callbacks);
          }
          tempToRealTaskIdRef.current.set(immediateTaskId, realTaskId);
        }

        // Join the task room for receiving AI response events
        if (realTaskId !== immediateTaskId && realTaskId > 0) {
          await joinTask(realTaskId);
        } else if (request.task_id && request.task_id > 0) {
          // Existing task, join the room for receiving AI response events
          await joinTask(request.task_id);
        }

        // Track subtask to task mapping (this is the user's subtask)
        if (subtaskId) {
          subtaskToTaskRef.current.set(subtaskId, realTaskId);
        }

        // Message sent successfully - call onMessageSent callback with localMessageId
        // NO REFRESH - the UI will display user message from messages Map
        const finalTaskId = realTaskId > 0 ? realTaskId : immediateTaskId;
        options?.onMessageSent?.(userMessageId, finalTaskId, subtaskId || 0);

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
          // Note: AI completion is handled by the streaming state change, no callback needed
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
      // Check WebSocket connection
      if (!isConnected) {
        return false;
      }

      // Check if already streaming for this task
      const existingState = streamStates.get(taskId);
      if (existingState && computeIsStreaming(existingState.messages)) {
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

          // Track subtask to task mapping
          subtaskToTaskRef.current.set(subtask_id, taskId);

          // Store callbacks
          if (options) {
            callbacksRef.current.set(taskId, {
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

          return true;
        }

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
   * Simple: merge backend messages into existing messages (don't replace)
   */
  /**
   * Sync backend subtasks to unified messages Map
   *
   * Simple: merge backend messages into existing messages (don't replace)
   */
  const syncBackendMessages = useCallback(
    (taskId: number, subtasks: TaskDetailSubtask[], options?: SyncBackendMessagesOptions): void => {
      if (!subtasks || subtasks.length === 0) return;

      const { teamName, isGroupChat, currentUserId, currentUserName } = options || {};

      setStreamStates(prev => {
        const newMap = new Map(prev);
        const currentState = newMap.get(taskId) || { ...defaultStreamState };
        // Start with existing messages, don't create new Map
        const messages = new Map(currentState.messages);

        // Build a set of existing subtaskIds to check for duplicates
        // This handles the case where user message has temp ID but same subtaskId
        const existingSubtaskIds = new Set<number>();
        // Count existing user messages (with temp IDs like "user-xxx")
        // These are messages added by sendMessage that may not have subtaskId yet
        let existingUserMessageCount = 0;
        for (const msg of messages.values()) {
          if (msg.subtaskId) {
            existingSubtaskIds.add(msg.subtaskId);
          }
          if (msg.type === 'user') {
            existingUserMessageCount++;
          }
        }

        // Count incoming user messages from backend
        const incomingUserSubtasks = subtasks.filter(
          s => s.role === 'USER' || s.role?.toUpperCase() === 'USER'
        );

        for (const subtask of subtasks) {
          // Track subtask to task mapping for WebSocket event handling
          // IMPORTANT: This must be done for ALL subtasks, including RUNNING ones,
          // so that chat:chunk events can find the correct taskId
          subtaskToTaskRef.current.set(subtask.id, taskId);

          const isUserMessage = subtask.role === 'USER' || subtask.role?.toUpperCase() === 'USER';
          const messageId = isUserMessage ? `user-backend-${subtask.id}` : `ai-${subtask.id}`;

          // Skip if already exists by message ID (don't overwrite streaming messages)
          if (messages.has(messageId)) {
            continue;
          }

          // Skip if already exists by subtaskId (handles temp ID user messages)
          if (existingSubtaskIds.has(subtask.id)) {
            continue;
          }

          // KEY FIX: Skip USER messages if we already have the same number of user messages
          // This handles the race condition where sendMessage adds a user message with temp ID,
          // but syncBackendMessages is called before the subtaskId is set on that message.
          // We compare counts: if existing user messages >= incoming user subtasks, skip adding more.
          if (isUserMessage && existingUserMessageCount >= incomingUserSubtasks.length) {
            continue;
          }

          // Check if frontend already has error state from chat:error WebSocket event
          const existingMessage = currentState.messages.get(messageId);
          const hasFrontendError =
            existingMessage && existingMessage.status === 'error' && existingMessage.error;

          // For RUNNING/PENDING AI messages:
          // - If we already have a streaming message for this subtask (from chat:start), skip
          // - Otherwise, create a streaming placeholder so the message is visible
          // This handles the page refresh case where chat:start was missed
          if (!isUserMessage && (subtask.status === 'RUNNING' || subtask.status === 'PENDING')) {
            // Check if we already have this AI message (created by chat:start)
            const existingAiMessage = messages.get(messageId);
            if (existingAiMessage) {
              // Already have this message, skip
              continue;
            }
            // Create a streaming placeholder for this RUNNING message
            // This ensures the message is visible after page refresh
            const content = typeof subtask.result?.value === 'string' ? subtask.result.value : '';
            messages.set(messageId, {
              id: messageId,
              type: 'ai',
              status: hasFrontendError ? 'error' : 'streaming', // Preserve error state if exists
              content,
              timestamp: new Date(subtask.created_at).getTime(),
              subtaskId: subtask.id,
              messageId: subtask.message_id,
              attachments: subtask.attachments,
              botName: subtask.bots?.[0]?.name || teamName,
              subtaskStatus: subtask.status,
              result: subtask.result as UnifiedMessage['result'],
              error: hasFrontendError ? existingMessage.error : undefined, // Preserve error if exists
            });
            continue;
          }

          // Determine status
          let status: MessageStatus = 'completed';
          if (subtask.status === 'FAILED' || subtask.status === 'CANCELLED') {
            status = 'error';
          } else if (hasFrontendError) {
            // Preserve frontend error state when backend DB hasn't been updated yet
            status = 'error';
          }

          // Get content
          const content = isUserMessage
            ? subtask.prompt || ''
            : typeof subtask.result?.value === 'string'
              ? subtask.result.value
              : '';

          // Determine error field using OR logic:
          // 1. Use frontend error if it exists (from chat:error WebSocket event)
          // 2. Otherwise use backend error_message (from FAILED/CANCELLED status)
          // This preserves frontend error state when backend DB hasn't been updated yet
          const errorField = hasFrontendError
            ? existingMessage.error
            : subtask.error_message || undefined;

          messages.set(messageId, {
            id: messageId,
            type: isUserMessage ? 'user' : 'ai',
            status,
            content,
            timestamp: new Date(subtask.created_at).getTime(),
            subtaskId: subtask.id,
            messageId: subtask.message_id,
            attachments: subtask.attachments,
            botName: !isUserMessage && subtask.bots?.[0]?.name ? subtask.bots[0].name : teamName,
            senderUserName:
              subtask.sender_user_name ||
              (isUserMessage && subtask.sender_user_id === currentUserId
                ? currentUserName
                : undefined),
            senderUserId: subtask.sender_user_id || (isUserMessage ? currentUserId : undefined),
            shouldShowSender: isGroupChat && isUserMessage,
            subtaskStatus: subtask.status,
            result: subtask.result as UnifiedMessage['result'],
            error: errorField,
          });
        }

        // Find current streaming subtask ID
        let currentSubtaskId: number | null = null;
        for (const msg of messages.values()) {
          if (msg.type === 'ai' && msg.status === 'streaming') {
            currentSubtaskId = msg.subtaskId || null;
            break;
          }
        }

        newMap.set(taskId, { ...currentState, subtaskId: currentSubtaskId, messages });
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
