// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * React hook for Chat Shell streaming.
 *
 * Provides state management and controls for streaming chat responses.
 */

import { useState, useCallback, useRef } from 'react';
import { streamChat, StreamChatRequest, ChatStreamData } from '@/apis/chat';

/**
 * Options for useChatStream hook
 */
interface UseChatStreamOptions {
  /** Called when stream completes successfully */
  onComplete?: (taskId: number, subtaskId: number) => void;
  /** Called on error */
  onError?: (error: Error) => void;
  /** Called for each content chunk (optional, for custom handling) */
  onChunk?: (content: string) => void;
}

/**
 * Return type for useChatStream hook
 */
interface UseChatStreamReturn {
  /** Whether streaming is in progress */
  isStreaming: boolean;
  /** Accumulated streaming content */
  streamingContent: string;
  /** Error if any */
  error: Error | null;
  /** Task ID from the stream */
  taskId: number | null;
  /** Subtask ID from the stream */
  subtaskId: number | null;
  /** Start a new stream */
  startStream: (request: StreamChatRequest) => Promise<number>;
  /** Stop the current stream */
  stopStream: () => void;
  /** Reset streaming state */
  resetStream: () => void;
}

/**
 * Hook for managing Chat Shell streaming state.
 *
 * @example
 * ```tsx
 * const {
 *   isStreaming,
 *   streamingContent,
 *   startStream,
 *   stopStream,
 *   resetStream,
 * } = useChatStream({
 *   onComplete: (taskId, subtaskId) => {
 *     refreshTasks();
 *   },
 *   onError: (error) => {
 *     toast({ variant: 'destructive', title: error.message });
 *   },
 * });
 *
 * // Start streaming
 * await startStream({
 *   message: 'Hello',
 *   team_id: 1,
 * });
 * ```
 */
export function useChatStream(options: UseChatStreamOptions = {}): UseChatStreamReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [subtaskId, setSubtaskId] = useState<number | null>(null);

  const abortRef = useRef<(() => void) | null>(null);
  const optionsRef = useRef(options);

  // Keep options ref updated
  optionsRef.current = options;

  /**
   * Start a new streaming chat request.
   *
   * @param request - Chat request parameters
   * @returns Task ID from the stream
   */
  const startStream = useCallback(async (request: StreamChatRequest): Promise<number> => {
    // Reset state
    setIsStreaming(true);
    setStreamingContent('');
    setError(null);
    setTaskId(request.task_id || null);
    setSubtaskId(null);

    let resolvedTaskId = request.task_id || 0;

    const { abort } = await streamChat(request, {
      onMessage: (data: ChatStreamData) => {
        // Update task/subtask IDs from first message
        if (data.task_id) {
          resolvedTaskId = data.task_id;
          setTaskId(data.task_id);
        }
        if (data.subtask_id) {
          setSubtaskId(data.subtask_id);
        }

        // Append content
        if (data.content) {
          setStreamingContent((prev) => prev + data.content);
          optionsRef.current.onChunk?.(data.content);
        }
      },
      onError: (err: Error) => {
        setError(err);
        setIsStreaming(false);
        optionsRef.current.onError?.(err);
      },
      onComplete: (completedTaskId: number, completedSubtaskId: number) => {
        setIsStreaming(false);
        setTaskId(completedTaskId);
        setSubtaskId(completedSubtaskId);
        optionsRef.current.onComplete?.(completedTaskId, completedSubtaskId);
      },
    });

    abortRef.current = abort;
    return resolvedTaskId;
  }, []);

  /**
   * Stop the current streaming request.
   */
  const stopStream = useCallback(() => {
    abortRef.current?.();
    setIsStreaming(false);
  }, []);

  /**
   * Reset all streaming state.
   */
  const resetStream = useCallback(() => {
    setStreamingContent('');
    setError(null);
    setTaskId(null);
    setSubtaskId(null);
  }, []);

  return {
    isStreaming,
    streamingContent,
    error,
    taskId,
    subtaskId,
    startStream,
    stopStream,
    resetStream,
  };
}

export default useChatStream;