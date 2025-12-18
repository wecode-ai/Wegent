// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for subscribing to group chat streams via SSE
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeGroupStream } from '@/apis/group-chat';

interface StreamChunk {
  content: string;
  done: boolean;
  subtask_id: number;
  result?: Record<string, unknown>;
}

interface UseGroupChatStreamOptions {
  taskId: number;
  subtaskId?: number; // undefined means not subscribed
  offset?: number;
  onChunk?: (chunk: StreamChunk) => void;
  onComplete?: (result?: Record<string, unknown>) => void;
  onError?: (error: string) => void;
}

interface UseGroupChatStreamResult {
  content: string;
  isStreaming: boolean;
  isComplete: boolean;
  error: string | null;
  result?: Record<string, unknown>;
  disconnect: () => void;
}

/**
 * Hook for subscribing to group chat streams via SSE
 *
 * When subtaskId changes from undefined to a number, automatically connects to the SSE stream.
 * When subtaskId changes back to undefined, disconnects.
 * Supports offset-based resume for recovery from disconnections.
 *
 * @param options - Configuration options
 * @returns Stream state and control functions
 */
export function useGroupChatStream(options: UseGroupChatStreamOptions): UseGroupChatStreamResult {
  const { taskId, subtaskId, offset = 0, onChunk, onComplete, onError } = options;

  const [content, setContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown>>();

  const eventSourceRef = useRef<EventSource | null>(null);
  const isMountedRef = useRef(true);

  // Disconnect function
  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  // Connect to SSE stream
  useEffect(() => {
    // If no subtaskId, disconnect
    if (subtaskId === undefined) {
      disconnect();
      return;
    }

    // Reset state
    setContent('');
    setIsComplete(false);
    setError(null);
    setResult(undefined);
    setIsStreaming(true);

    // Create EventSource
    const eventSource = subscribeGroupStream(taskId, subtaskId, offset);
    eventSourceRef.current = eventSource;

    // Handle messages
    eventSource.onmessage = event => {
      if (!isMountedRef.current) return;

      try {
        const chunk: StreamChunk = JSON.parse(event.data);

        if (chunk.done) {
          // Stream complete
          setIsComplete(true);
          setIsStreaming(false);
          if (chunk.result) {
            setResult(chunk.result);
          }
          if (onComplete) {
            onComplete(chunk.result);
          }
          disconnect();
        } else {
          // Append content
          setContent(prev => prev + chunk.content);
          if (onChunk) {
            onChunk(chunk);
          }
        }
      } catch (err) {
        console.error('[useGroupChatStream] Failed to parse chunk:', err);
      }
    };

    // Handle errors
    eventSource.onerror = event => {
      if (!isMountedRef.current) return;

      const errorMessage = 'Stream connection error';
      setError(errorMessage);
      setIsStreaming(false);
      console.error('[useGroupChatStream] SSE error:', event);

      if (onError) {
        onError(errorMessage);
      }

      disconnect();
    };

    // Cleanup on unmount or subtaskId change
    return () => {
      disconnect();
    };
  }, [taskId, subtaskId, offset, onChunk, onComplete, onError, disconnect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      disconnect();
    };
  }, [disconnect]);

  return {
    content,
    isStreaming,
    isComplete,
    error,
    result,
    disconnect,
  };
}
