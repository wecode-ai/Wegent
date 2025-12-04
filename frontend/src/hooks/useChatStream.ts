// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * React hook for Chat Shell streaming.
 *
 * Provides state management and controls for streaming chat responses.
 */

import { useState, useCallback, useRef } from 'react';
import { streamChat, cancelChat, StreamChatRequest, ChatStreamData } from '@/apis/chat';
import { parseError } from '@/utils/errorParser';

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
  /** Whether stop operation is in progress (waiting for backend confirmation) */
  isStopping: boolean;
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
  const [isStopping, setIsStopping] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [subtaskId, setSubtaskId] = useState<number | null>(null);

  const abortRef = useRef<(() => void) | null>(null);
  const optionsRef = useRef(options);
  const subtaskIdRef = useRef<number | null>(null);
  // Use ref to track streaming content for reliable access in stopStream
  const streamingContentRef = useRef('');

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
    streamingContentRef.current = ''; // Reset ref too
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
          subtaskIdRef.current = data.subtask_id;
        }

        // Append content
        if (data.content) {
          setStreamingContent(prev => {
            const newContent = prev + data.content;
            streamingContentRef.current = newContent; // Keep ref in sync
            return newContent;
          });
          optionsRef.current.onChunk?.(data.content);
        }
      },
      onError: (err: Error) => {
        // Parse error to provide better error information
        const parsed = parseError(err);
        const enhancedError = new Error(parsed.message) as Error & {
          type?: string;
          originalError?: string;
        };
        enhancedError.type = parsed.type;
        enhancedError.originalError = parsed.originalError;

        setError(enhancedError);
        setIsStreaming(false);
        optionsRef.current.onError?.(enhancedError);
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
   * Stop the current streaming request and cancel on backend.
   * Saves partial content that was received before cancellation.
   *
   * IMPORTANT: This function waits for backend confirmation before updating UI
   * to ensure the server has actually stopped generating content.
   *
   * After stopping, the onComplete callback is called to trigger a refresh,
   * which will fetch the saved partial content from the backend.
   */
  const stopStream = useCallback(async () => {
    // Set stopping state to show loading indicator
    setIsStopping(true);

    // Get the current streaming content from ref (reliable access)
    const partialContent = streamingContentRef.current;

    // Get task ID and subtask ID before aborting
    const currentTaskId = taskId;
    const currentSubtaskId = subtaskIdRef.current;

    // First abort the frontend fetch request to stop receiving new content
    abortRef.current?.();

    // Call backend to cancel the subtask with partial content
    // Wait for backend confirmation before updating UI state
    if (currentSubtaskId) {
      try {
        await cancelChat({
          subtask_id: currentSubtaskId,
          partial_content: partialContent || undefined,
        });

        // Call onComplete to trigger refresh and show the saved partial content
        // The backend marks the task as COMPLETED, so we treat this as a successful completion
        if (currentTaskId && currentSubtaskId) {
          optionsRef.current.onComplete?.(currentTaskId, currentSubtaskId);
        }
      } catch (error) {
        console.error('[CANCEL_DEBUG] Failed to stop chat:', error);
        // Even if backend cancel fails, we should still stop the frontend streaming
        // to prevent UI from being stuck in streaming state
      }
    } else {
      console.warn('[CANCEL_DEBUG] stopStream: no subtaskId available, cannot call cancelChat API');
    }

    // Only update UI state after backend has confirmed cancellation
    // This ensures the server has actually stopped generating content
    setIsStreaming(false);
    setIsStopping(false);
  }, [taskId]);

  /**
   * Reset all streaming state.
   */
  const resetStream = useCallback(() => {
    setStreamingContent('');
    streamingContentRef.current = ''; // Reset ref too
    setError(null);
    setTaskId(null);
    setSubtaskId(null);
  }, []);

  return {
    isStreaming,
    isStopping,
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
