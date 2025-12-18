// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for subscribing to group chat streams via WebSocket
 *
 * This hook uses the global Socket.IO connection to receive streaming content
 * for group chat messages. It replaces the previous SSE-based implementation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from '@/contexts/SocketContext';
import { ServerEvents, ChatChunkPayload, ChatDonePayload, ChatErrorPayload } from '@/types/socket';

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
 * Hook for subscribing to group chat streams via WebSocket
 *
 * When subtaskId changes from undefined to a number, automatically listens for streaming events.
 * When subtaskId changes back to undefined, stops listening.
 *
 * @param options - Configuration options
 * @returns Stream state and control functions
 */
export function useGroupChatStream(options: UseGroupChatStreamOptions): UseGroupChatStreamResult {
  const { taskId, subtaskId, onChunk, onComplete, onError } = options;

  const [content, setContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown>>();

  const { socket, isConnected, joinTask } = useSocket();
  const isMountedRef = useRef(true);

  // Store callbacks in refs to avoid re-triggering effects
  const onChunkRef = useRef(onChunk);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);

  // Keep refs updated
  useEffect(() => {
    onChunkRef.current = onChunk;
  }, [onChunk]);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Disconnect function (cleanup handlers)
  const disconnect = useCallback(() => {
    setIsStreaming(false);
  }, []);

  // Handle chat:chunk event
  const handleChatChunk = useCallback(
    (data: ChatChunkPayload) => {
      if (!isMountedRef.current) return;
      if (subtaskId && data.subtask_id !== subtaskId) return;

      const chunk: StreamChunk = {
        content: data.content,
        done: false,
        subtask_id: data.subtask_id,
      };

      setContent(prev => prev + data.content);
      onChunkRef.current?.(chunk);
    },
    [subtaskId]
  );

  // Handle chat:done event
  const handleChatDone = useCallback(
    (data: ChatDonePayload) => {
      if (!isMountedRef.current) return;
      if (subtaskId && data.subtask_id !== subtaskId) return;

      setIsComplete(true);
      setIsStreaming(false);
      if (data.result) {
        setResult(data.result);
      }
      onCompleteRef.current?.(data.result);
    },
    [subtaskId]
  );

  // Handle chat:error event
  const handleChatError = useCallback(
    (data: ChatErrorPayload) => {
      if (!isMountedRef.current) return;
      if (subtaskId && data.subtask_id !== subtaskId) return;

      const errorMessage = data.error || 'Stream error';
      setError(errorMessage);
      setIsStreaming(false);
      onErrorRef.current?.(errorMessage);
    },
    [subtaskId]
  );

  // Subscribe to WebSocket events when subtaskId is set
  useEffect(() => {
    // If no subtaskId or not connected, don't subscribe
    if (subtaskId == null || typeof subtaskId !== 'number' || !socket || !isConnected) {
      disconnect();
      return;
    }

    // Reset state
    setContent('');
    setIsComplete(false);
    setError(null);
    setResult(undefined);
    setIsStreaming(true);

    // Join task room to receive events
    joinTask(taskId).catch(err => {
      console.error('[useGroupChatStream] Failed to join task room:', err);
    });

    // Register event handlers
    socket.on(ServerEvents.CHAT_CHUNK, handleChatChunk);
    socket.on(ServerEvents.CHAT_DONE, handleChatDone);
    socket.on(ServerEvents.CHAT_ERROR, handleChatError);

    // Cleanup on unmount or subtaskId change
    return () => {
      socket.off(ServerEvents.CHAT_CHUNK, handleChatChunk);
      socket.off(ServerEvents.CHAT_DONE, handleChatDone);
      socket.off(ServerEvents.CHAT_ERROR, handleChatError);
      disconnect();
    };
  }, [
    taskId,
    subtaskId,
    socket,
    isConnected,
    joinTask,
    handleChatChunk,
    handleChatDone,
    handleChatError,
    disconnect,
  ]);

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
