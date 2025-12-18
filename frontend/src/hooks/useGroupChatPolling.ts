// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for polling new messages in group chat
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { pollNewMessages, SubtaskWithSender } from '@/apis/group-chat';

interface UseGroupChatPollingOptions {
  taskId: number;
  isGroupChat: boolean;
  enabled?: boolean;
  pollingInterval?: number; // in milliseconds, default 1000
  onNewMessages?: (messages: SubtaskWithSender[]) => void;
  onStreamingDetected?: (subtaskId: number) => void;
}

interface UseGroupChatPollingResult {
  newMessages: SubtaskWithSender[];
  isPolling: boolean;
  hasStreaming: boolean;
  streamingSubtaskId?: number;
  error: Error | null;
  clearMessages: () => void;
}

/**
 * Hook for polling new messages in group chat
 *
 * Polls the backend every 1 second (by default) for new messages.
 * Automatically tracks the last received subtask ID and only fetches incremental updates.
 *
 * @param options - Configuration options
 * @returns Polling state and control functions
 */
export function useGroupChatPolling(
  options: UseGroupChatPollingOptions
): UseGroupChatPollingResult {
  const {
    taskId,
    isGroupChat,
    enabled = true,
    pollingInterval = 1000,
    onNewMessages,
    onStreamingDetected,
  } = options;

  const [newMessages, setNewMessages] = useState<SubtaskWithSender[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [hasStreaming, setHasStreaming] = useState(false);
  const [streamingSubtaskId, setStreamingSubtaskId] = useState<number>();
  const [error, setError] = useState<Error | null>(null);

  const lastSubtaskIdRef = useRef<number | undefined>(undefined);
  const pollingTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const isMountedRef = useRef(true);

  // Clear messages
  const clearMessages = useCallback(() => {
    setNewMessages([]);
  }, []);

  // Polling function
  const poll = useCallback(async () => {
    if (!isGroupChat || !enabled || !isMountedRef.current) {
      return;
    }

    try {
      setIsPolling(true);
      setError(null);

      const response = await pollNewMessages(taskId, lastSubtaskIdRef.current);

      if (!isMountedRef.current) return;

      // Update last subtask ID
      if (response.messages.length > 0) {
        const latestMessage = response.messages[response.messages.length - 1];
        lastSubtaskIdRef.current = latestMessage.id;

        // Add new messages
        setNewMessages(prev => [...prev, ...response.messages]);

        // Notify callback
        if (onNewMessages) {
          onNewMessages(response.messages);
        }
      }

      // Update streaming status
      setHasStreaming(response.has_streaming);
      setStreamingSubtaskId(response.streaming_subtask_id);

      // Notify streaming detected
      if (response.has_streaming && response.streaming_subtask_id && onStreamingDetected) {
        onStreamingDetected(response.streaming_subtask_id);
      }
    } catch (err) {
      if (!isMountedRef.current) return;

      const error = err as Error;
      setError(error);
      console.error('[useGroupChatPolling] Polling error:', error);
    } finally {
      if (isMountedRef.current) {
        setIsPolling(false);
      }
    }
  }, [taskId, isGroupChat, enabled, onNewMessages, onStreamingDetected]);

  // Start polling
  useEffect(() => {
    if (!isGroupChat || !enabled) {
      return;
    }

    // Initial poll
    poll();

    // Set up interval
    pollingTimerRef.current = setInterval(() => {
      poll();
    }, pollingInterval);

    return () => {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
      }
    };
  }, [poll, isGroupChat, enabled, pollingInterval]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
      }
    };
  }, []);

  return {
    newMessages,
    isPolling,
    hasStreaming,
    streamingSubtaskId,
    error,
    clearMessages,
  };
}
