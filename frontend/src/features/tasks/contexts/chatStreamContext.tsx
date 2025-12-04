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
 */

import React, { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import { streamChat, cancelChat, StreamChatRequest, ChatStreamData } from '@/apis/chat';

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
    }
  ) => Promise<number>;
  /** Stop the stream for a specific task */
  stopStream: (taskId: number) => Promise<void>;
  /** Reset stream state for a specific task */
  resetStream: (taskId: number) => void;
  /** Clear all stream states */
  clearAllStreams: () => void;
}

const ChatStreamContext = createContext<ChatStreamContextType | undefined>(undefined);

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

  // Refs for abort controllers and callbacks (don't need to trigger re-renders)
  const abortControllersRef = useRef<Map<number, () => void>>(new Map());
  const callbacksRef = useRef<
    Map<
      number,
      {
        onComplete?: (taskId: number, subtaskId: number) => void;
        onError?: (error: Error) => void;
      }
    >
  >(new Map());
  // Ref to track streaming content for reliable access in stopStream
  const streamingContentRefs = useRef<Map<number, string>>(new Map());

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
   * Start a new stream for a task
   */
  /**
   * Start a new stream for a task
   */
  const startStream = useCallback(
    async (
      request: StreamChatRequest,
      options?: {
        pendingUserMessage?: string;
        pendingAttachment?: unknown;
        onComplete?: (taskId: number, subtaskId: number) => void;
        onError?: (error: Error) => void;
        /** Callback when task ID is resolved (for new tasks) */
        onTaskIdResolved?: (taskId: number) => void;
      }
    ): Promise<number> => {
      // Task ID will be resolved from response headers immediately
      // For existing tasks, use the provided task_id
      // For new tasks, we'll get the real task_id from the first message (via headers)
      let resolvedTaskId = request.task_id || 0;
      let hasInitializedState = false;

      // Store callbacks (will be moved to real task ID when resolved)
      const tempCallbacksKey = request.task_id || -Date.now();
      if (options?.onComplete || options?.onError || options?.onTaskIdResolved) {
        callbacksRef.current.set(tempCallbacksKey, {
          onComplete: options.onComplete,
          onError: options.onError,
        });
      }

      const { abort, taskId: returnedTaskId } = await streamChat(request, {
        onMessage: (data: ChatStreamData) => {
          // Update task ID from first message (now available immediately via headers)
          if (data.task_id && data.task_id !== resolvedTaskId) {
            const oldTaskId = resolvedTaskId;
            resolvedTaskId = data.task_id;

            // Initialize state with the real task ID
            if (!hasInitializedState) {
              hasInitializedState = true;
              updateStreamState(resolvedTaskId, {
                isStreaming: true,
                isStopping: false,
                streamingContent: '',
                error: null,
                subtaskId: data.subtask_id || null,
                pendingUserMessage: options?.pendingUserMessage || null,
                pendingAttachment: options?.pendingAttachment || null,
              });
              streamingContentRefs.current.set(resolvedTaskId, '');

              // Move callbacks to real task ID
              const callbacks = callbacksRef.current.get(tempCallbacksKey);
              if (callbacks && tempCallbacksKey !== resolvedTaskId) {
                callbacksRef.current.delete(tempCallbacksKey);
                callbacksRef.current.set(resolvedTaskId, callbacks);
              }
            }

            // If we had state under old task ID (0), move it
            if (oldTaskId !== 0 && oldTaskId !== resolvedTaskId) {
              setStreamStates(prev => {
                const newMap = new Map(prev);
                const oldState = newMap.get(oldTaskId);
                if (oldState) {
                  newMap.delete(oldTaskId);
                  newMap.set(resolvedTaskId, oldState);
                }
                return newMap;
              });

              // Move refs
              const oldAbort = abortControllersRef.current.get(oldTaskId);
              if (oldAbort) {
                abortControllersRef.current.delete(oldTaskId);
                abortControllersRef.current.set(resolvedTaskId, oldAbort);
              }

              const oldCallbacks = callbacksRef.current.get(oldTaskId);
              if (oldCallbacks) {
                callbacksRef.current.delete(oldTaskId);
                callbacksRef.current.set(resolvedTaskId, oldCallbacks);
              }

              const oldContent = streamingContentRefs.current.get(oldTaskId);
              if (oldContent !== undefined) {
                streamingContentRefs.current.delete(oldTaskId);
                streamingContentRefs.current.set(resolvedTaskId, oldContent);
              }
            }

            // Notify caller about the resolved task ID
            options?.onTaskIdResolved?.(resolvedTaskId);
          } else if (!hasInitializedState && resolvedTaskId > 0) {
            // For existing tasks, initialize state on first message
            hasInitializedState = true;
            updateStreamState(resolvedTaskId, {
              isStreaming: true,
              isStopping: false,
              streamingContent: '',
              error: null,
              subtaskId: data.subtask_id || null,
              pendingUserMessage: options?.pendingUserMessage || null,
              pendingAttachment: options?.pendingAttachment || null,
            });
            streamingContentRefs.current.set(resolvedTaskId, '');

            // Move callbacks to real task ID if needed
            if (tempCallbacksKey !== resolvedTaskId) {
              const callbacks = callbacksRef.current.get(tempCallbacksKey);
              if (callbacks) {
                callbacksRef.current.delete(tempCallbacksKey);
                callbacksRef.current.set(resolvedTaskId, callbacks);
              }
            }
          }

          // Update subtask ID
          if (data.subtask_id && hasInitializedState) {
            updateStreamState(resolvedTaskId, { subtaskId: data.subtask_id });
          }

          // Append content
          if (data.content && hasInitializedState) {
            const currentContent = streamingContentRefs.current.get(resolvedTaskId) || '';
            const newContent = currentContent + data.content;
            streamingContentRefs.current.set(resolvedTaskId, newContent);
            updateStreamState(resolvedTaskId, { streamingContent: newContent });
          }
        },
        onError: (err: Error) => {
          updateStreamState(resolvedTaskId, {
            error: err,
            isStreaming: false,
            pendingUserMessage: null,
            pendingAttachment: null,
          });
          const callbacks = callbacksRef.current.get(resolvedTaskId);
          callbacks?.onError?.(err);
        },
        onComplete: (completedTaskId: number, completedSubtaskId: number) => {
          // Don't clear state immediately to allow UI to handle transition
          // The state will be cleared when resetStream is called by the consumer
          updateStreamState(completedTaskId, {
            subtaskId: completedSubtaskId,
          });
          const callbacks = callbacksRef.current.get(completedTaskId);
          callbacks?.onComplete?.(completedTaskId, completedSubtaskId);
        },
      });

      // Store abort controller with the resolved task ID
      if (resolvedTaskId > 0) {
        abortControllersRef.current.set(resolvedTaskId, abort);
      } else if (returnedTaskId > 0) {
        // Use the task ID returned from streamChat if available
        abortControllersRef.current.set(returnedTaskId, abort);
        resolvedTaskId = returnedTaskId;
      }

      return resolvedTaskId;
    },
    [updateStreamState]
  );

  /**
   * Stop the stream for a specific task
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

      // Abort frontend fetch
      const abort = abortControllersRef.current.get(taskId);
      abort?.();

      // Call backend to cancel
      if (subtaskId) {
        try {
          await cancelChat({
            subtask_id: subtaskId,
            partial_content: partialContent || undefined,
          });

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
    [streamStates, updateStreamState]
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
    abortControllersRef.current.delete(taskId);
    callbacksRef.current.delete(taskId);
    streamingContentRefs.current.delete(taskId);
  }, []);

  /**
   * Clear all stream states
   */
  const clearAllStreams = useCallback((): void => {
    // Abort all active streams
    abortControllersRef.current.forEach(abort => abort());
    abortControllersRef.current.clear();
    callbacksRef.current.clear();
    streamingContentRefs.current.clear();
    setStreamStates(new Map());
  }, []);

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
