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
} from '@/types/socket';

/**
 * State for a single streaming task
 */
interface StreamState {
  /** Whether streaming is in progress */
  isStreaming: boolean;
  /** Whether stop operation is in progress */
  isStopping: boolean;
  /** Accumulated streaming content */
  streamingContent: string;
  /** Error if any */
  error: Error | null;
  /** Subtask ID from the stream */
  subtaskId: number | null;
  /** Pending user message for optimistic UI */
  pendingUserMessage: string | null;
  /** Pending attachment for optimistic UI */
  pendingAttachment: unknown | null;
}

/**
 * Map of taskId to stream state
 */
type StreamStateMap = Map<number, StreamState>;

/**
 * Request parameters for starting a stream (compatible with old SSE API)
 */
export interface StreamChatRequest {
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
  /** Start a new stream for a task */
  startStream: (
    request: StreamChatRequest,
    options?: {
      pendingUserMessage?: string;
      pendingAttachment?: unknown;
      onComplete?: (taskId: number, subtaskId: number) => void;
      onError?: (error: Error) => void;
      /** Callback when task ID is resolved (for new tasks) */
      onTaskIdResolved?: (taskId: number) => void;
      /** Temporary task ID for immediate UI feedback (for new tasks) */
      immediateTaskId?: number;
    }
  ) => Promise<number>;
  /** Stop the stream for a specific task */
  stopStream: (taskId: number) => Promise<void>;
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
}

// Export the context for components that need optional access (e.g., ClarificationForm)
export const ChatStreamContext = createContext<ChatStreamContextType | undefined>(undefined);

/**
 * Default stream state
 */
const defaultStreamState: StreamState = {
  isStreaming: false,
  isStopping: false,
  streamingContent: '',
  error: null,
  subtaskId: null,
  pendingUserMessage: null,
  pendingAttachment: null,
};

/**
 * Provider component for chat stream context
 */
export function ChatStreamProvider({ children }: { children: ReactNode }) {
  // Use state to trigger re-renders when stream states change
  const [streamStates, setStreamStates] = useState<StreamStateMap>(new Map());

  // Get socket context
  const { isConnected, sendChatMessage, cancelChatStream, registerChatHandlers, joinTask } =
    useSocket();

  // Refs for callbacks (don't need to trigger re-renders)
  const callbacksRef = useRef<
    Map<
      number,
      {
        onComplete?: (taskId: number, subtaskId: number) => void;
        onError?: (error: Error) => void;
        onTaskIdResolved?: (taskId: number) => void;
      }
    >
  >(new Map());
  // Ref to track streaming content for reliable access in stopStream
  const streamingContentRefs = useRef<Map<number, string>>(new Map());
  // Ref to track temporary task ID to real task ID mapping
  const tempToRealTaskIdRef = useRef<Map<number, number>>(new Map());
  // Ref to track which subtask belongs to which task
  const subtaskToTaskRef = useRef<Map<number, number>>(new Map());

  /**
   * Update stream state for a specific task
   */
  const updateStreamState = useCallback((taskId: number, updates: Partial<StreamState>) => {
    setStreamStates(prev => {
      const newMap = new Map(prev);
      const currentState = newMap.get(taskId) || { ...defaultStreamState };
      newMap.set(taskId, { ...currentState, ...updates });
      return newMap;
    });
  }, []);

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
   */
  const isTaskStreaming = useCallback(
    (taskId: number): boolean => {
      const state = streamStates.get(taskId);
      return state?.isStreaming || false;
    },
    [streamStates]
  );

  /**
   * Get all currently streaming task IDs
   */
  const getStreamingTaskIds = useCallback((): number[] => {
    const ids: number[] = [];
    streamStates.forEach((state, taskId) => {
      if (state.isStreaming) {
        ids.push(taskId);
      }
    });
    return ids;
  }, [streamStates]);

  /**
   * Handle chat:start event from WebSocket
   */
  const handleChatStart = useCallback((data: ChatStartPayload) => {
    const { task_id, subtask_id } = data;

    // Track subtask to task mapping
    if (subtask_id) {
      subtaskToTaskRef.current.set(subtask_id, task_id);
    }

    // Look for any temporary task ID (negative) that might be waiting for this real task ID
    // If we find a stream state with a temporary ID, we should update that instead
    setStreamStates(prev => {
      const newMap = new Map(prev);

      // Check if we already have state for this task_id
      if (newMap.has(task_id)) {
        const currentState = newMap.get(task_id)!;
        newMap.set(task_id, {
          ...currentState,
          isStreaming: true,
          subtaskId: subtask_id,
        });
        return newMap;
      }

      // Look for temporary task ID (negative number) that might need to be migrated
      // This happens when chat:start arrives before sendChatMessage response
      for (const [tempId, state] of newMap.entries()) {
        if (tempId < 0 && state.isStreaming && !state.subtaskId) {
          // Found a temporary streaming state without subtask ID
          // This is likely the one waiting for this chat:start
          console.log('[ChatStreamContext] Migrating temp task ID', {
            tempId,
            realTaskId: task_id,
          });

          // Move state from temp ID to real ID
          newMap.delete(tempId);
          newMap.set(task_id, {
            ...state,
            subtaskId: subtask_id,
          });

          // Update refs
          const oldContent = streamingContentRefs.current.get(tempId);
          if (oldContent !== undefined) {
            streamingContentRefs.current.delete(tempId);
            streamingContentRefs.current.set(task_id, oldContent);
          }

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

      // No existing state found, create new one
      const currentState = newMap.get(task_id) || { ...defaultStreamState };
      newMap.set(task_id, {
        ...currentState,
        isStreaming: true,
        subtaskId: subtask_id,
      });
      return newMap;
    });

    console.log('[ChatStreamContext] chat:start received', { task_id, subtask_id });
  }, []);

  /**
   * Handle chat:chunk event from WebSocket
   */
  const handleChatChunk = useCallback(
    (data: ChatChunkPayload) => {
      const { subtask_id, content } = data;

      // Find task ID from subtask
      const taskId = subtaskToTaskRef.current.get(subtask_id);
      if (!taskId) {
        console.warn('[ChatStreamContext] Received chunk for unknown subtask:', subtask_id);
        return;
      }

      // Append content
      const currentContent = streamingContentRefs.current.get(taskId) || '';
      const newContent = currentContent + content;
      streamingContentRefs.current.set(taskId, newContent);
      updateStreamState(taskId, { streamingContent: newContent });
    },
    [updateStreamState]
  );

  /**
   * Handle chat:done event from WebSocket
   */
  const handleChatDone = useCallback(
    (data: ChatDonePayload) => {
      const { subtask_id, result } = data;

      // Find task ID from subtask
      const taskId = subtaskToTaskRef.current.get(subtask_id);
      if (!taskId) {
        console.warn('[ChatStreamContext] Received done for unknown subtask:', subtask_id);
        return;
      }

      // Get final content
      const finalContent =
        (result?.value as string) || streamingContentRefs.current.get(taskId) || '';

      // Update state
      updateStreamState(taskId, {
        isStreaming: false,
        isStopping: false,
        streamingContent: finalContent,
        pendingUserMessage: null,
        pendingAttachment: null,
      });

      // Call completion callback
      const callbacks = callbacksRef.current.get(taskId);
      callbacks?.onComplete?.(taskId, subtask_id);

      console.log('[ChatStreamContext] chat:done received', { task_id: taskId, subtask_id });
    },
    [updateStreamState]
  );

  /**
   * Handle chat:error event from WebSocket
   */
  const handleChatError = useCallback(
    (data: ChatErrorPayload) => {
      const { subtask_id, error } = data;

      // Find task ID from subtask
      const taskId = subtaskToTaskRef.current.get(subtask_id);
      if (!taskId) {
        console.warn('[ChatStreamContext] Received error for unknown subtask:', subtask_id);
        return;
      }

      const errorObj = new Error(error);

      // Update state
      updateStreamState(taskId, {
        isStreaming: false,
        isStopping: false,
        error: errorObj,
        pendingUserMessage: null,
        pendingAttachment: null,
      });

      // Call error callback
      const callbacks = callbacksRef.current.get(taskId);
      callbacks?.onError?.(errorObj);

      console.error('[ChatStreamContext] chat:error received', {
        task_id: taskId,
        subtask_id,
        error,
      });
    },
    [updateStreamState]
  );

  /**
   * Handle chat:cancelled event from WebSocket
   */
  const handleChatCancelled = useCallback(
    (data: ChatCancelledPayload) => {
      const { subtask_id } = data;

      // Find task ID from subtask
      const taskId = subtaskToTaskRef.current.get(subtask_id);
      if (!taskId) {
        console.warn('[ChatStreamContext] Received cancelled for unknown subtask:', subtask_id);
        return;
      }

      // Update state
      updateStreamState(taskId, {
        isStreaming: false,
        isStopping: false,
        pendingUserMessage: null,
        pendingAttachment: null,
      });

      // Call completion callback (cancelled is treated as completed)
      const callbacks = callbacksRef.current.get(taskId);
      callbacks?.onComplete?.(taskId, subtask_id);

      console.log('[ChatStreamContext] chat:cancelled received', { task_id: taskId, subtask_id });
    },
    [updateStreamState]
  );

  // Register WebSocket event handlers
  useEffect(() => {
    const handlers: ChatEventHandlers = {
      onChatStart: handleChatStart,
      onChatChunk: handleChatChunk,
      onChatDone: handleChatDone,
      onChatError: handleChatError,
      onChatCancelled: handleChatCancelled,
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
  ]);

  /**
   * Start a new stream for a task using WebSocket
   */
  const startStream = useCallback(
    async (
      request: StreamChatRequest,
      options?: {
        pendingUserMessage?: string;
        pendingAttachment?: unknown;
        onComplete?: (taskId: number, subtaskId: number) => void;
        onError?: (error: Error) => void;
        onTaskIdResolved?: (taskId: number) => void;
        immediateTaskId?: number;
      }
    ): Promise<number> => {
      console.log('[ChatStreamContext] startStream called', {
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

      // Store callbacks
      callbacksRef.current.set(immediateTaskId, {
        onComplete: options?.onComplete,
        onError: options?.onError,
        onTaskIdResolved: options?.onTaskIdResolved,
      });

      // Initialize stream state immediately for optimistic UI
      updateStreamState(immediateTaskId, {
        isStreaming: true,
        isStopping: false,
        streamingContent: '',
        error: null,
        subtaskId: null,
        pendingUserMessage: options?.pendingUserMessage || null,
        pendingAttachment: options?.pendingAttachment || null,
      });
      streamingContentRefs.current.set(immediateTaskId, '');

      // Convert request to WebSocket payload
      const payload: ChatSendPayload = {
        task_id: request.task_id,
        team_id: request.team_id,
        message: request.message,
        attachment_id: request.attachment_id,
        enable_web_search: request.enable_web_search,
        force_override_bot_model: request.model_id,
        force_override_bot_model_type: request.force_override_bot_model ? 'user' : undefined,
      };

      try {
        // Send message via WebSocket
        const response = await sendChatMessage(payload);

        // Handle undefined or error response
        if (!response) {
          const error = new Error('Failed to send message: no response from server');
          updateStreamState(immediateTaskId, {
            isStreaming: false,
            error,
            pendingUserMessage: null,
            pendingAttachment: null,
          });
          options?.onError?.(error);
          throw error;
        }

        if (response.error) {
          const error = new Error(response.error);
          updateStreamState(immediateTaskId, {
            isStreaming: false,
            error,
            pendingUserMessage: null,
            pendingAttachment: null,
          });
          options?.onError?.(error);
          throw error;
        }

        const realTaskId = response.task_id || immediateTaskId;
        const subtaskId = response.subtask_id;

        // If we got a real task ID different from immediate, migrate state
        if (realTaskId !== immediateTaskId && realTaskId > 0) {
          // Map temporary to real task ID
          tempToRealTaskIdRef.current.set(immediateTaskId, realTaskId);

          // Move state from immediateTaskId to realTaskId
          setStreamStates(prev => {
            const newMap = new Map(prev);
            const oldState = newMap.get(immediateTaskId);
            if (oldState) {
              newMap.delete(immediateTaskId);
              newMap.set(realTaskId, {
                ...oldState,
                subtaskId: subtaskId || null,
              });
            }
            return newMap;
          });

          // Move refs
          const oldContent = streamingContentRefs.current.get(immediateTaskId);
          if (oldContent !== undefined) {
            streamingContentRefs.current.delete(immediateTaskId);
            streamingContentRefs.current.set(realTaskId, oldContent);
          }

          // Move callbacks
          const callbacks = callbacksRef.current.get(immediateTaskId);
          if (callbacks) {
            callbacksRef.current.delete(immediateTaskId);
            callbacksRef.current.set(realTaskId, callbacks);
          }

          // Notify about resolved task ID
          options?.onTaskIdResolved?.(realTaskId);

          // Join the task room for receiving events
          await joinTask(realTaskId);
        } else if (request.task_id && request.task_id > 0) {
          // Existing task, join the room
          await joinTask(request.task_id);
        }

        // Track subtask to task mapping
        if (subtaskId) {
          subtaskToTaskRef.current.set(subtaskId, realTaskId);
        }

        console.log('[ChatStreamContext] Stream started via WebSocket', {
          immediateTaskId,
          realTaskId,
          subtaskId,
        });

        return realTaskId;
      } catch (error) {
        // Clean up on error
        updateStreamState(immediateTaskId, {
          isStreaming: false,
          error: error as Error,
          pendingUserMessage: null,
          pendingAttachment: null,
        });
        throw error;
      }
    },
    [isConnected, sendChatMessage, updateStreamState, joinTask]
  );

  /**
   * Stop the stream for a specific task using WebSocket
   */
  const stopStream = useCallback(
    async (taskId: number): Promise<void> => {
      const state = streamStates.get(taskId);
      if (!state?.isStreaming) return;

      // Set stopping state
      updateStreamState(taskId, { isStopping: true });

      // Get current content from ref
      const partialContent = streamingContentRefs.current.get(taskId) || '';
      const subtaskId = state.subtaskId;

      // Call backend to cancel via WebSocket
      if (subtaskId) {
        try {
          const result = await cancelChatStream(subtaskId, partialContent);

          if (result.error) {
            console.error('[ChatStreamContext] Failed to cancel stream:', result.error);
          }

          // Call onComplete to trigger refresh
          const callbacks = callbacksRef.current.get(taskId);
          callbacks?.onComplete?.(taskId, subtaskId);
        } catch (error) {
          console.error('[ChatStreamContext] Failed to stop chat:', error);
        }
      }

      // Update state
      updateStreamState(taskId, {
        isStreaming: false,
        isStopping: false,
        pendingUserMessage: null,
        pendingAttachment: null,
      });
    },
    [streamStates, updateStreamState, cancelChatStream]
  );

  /**
   * Reset stream state for a specific task
   */
  const resetStream = useCallback((taskId: number): void => {
    setStreamStates(prev => {
      const newMap = new Map(prev);
      newMap.delete(taskId);
      return newMap;
    });
    callbacksRef.current.delete(taskId);
    streamingContentRefs.current.delete(taskId);

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
    streamingContentRefs.current.clear();
    subtaskToTaskRef.current.clear();
    tempToRealTaskIdRef.current.clear();
    setStreamStates(new Map());
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
      if (existingState?.isStreaming) {
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
              onComplete: options.onComplete,
              onError: options.onError,
            });
          }

          // Initialize stream state with cached content
          const initialContent = cached_content || '';
          streamingContentRefs.current.set(taskId, initialContent);
          updateStreamState(taskId, {
            isStreaming: true,
            isStopping: false,
            streamingContent: initialContent,
            error: null,
            subtaskId: subtask_id,
            pendingUserMessage: null,
            pendingAttachment: null,
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
    [isConnected, streamStates, joinTask, updateStreamState]
  );

  return (
    <ChatStreamContext.Provider
      value={{
        getStreamState,
        isTaskStreaming,
        getStreamingTaskIds,
        startStream,
        stopStream,
        resetStream,
        clearAllStreams,
        resumeStream,
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
