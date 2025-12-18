// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Group Chat Sync Manager Component
 *
 * Integrates real-time message polling and stream subscription for group chats.
 * This component should be mounted when a group chat task is active.
 */

import { useEffect } from 'react';
import { useGroupChatPolling } from '@/hooks/useGroupChatPolling';
import { useGroupChatStream } from '@/hooks/useGroupChatStream';
import type { SubtaskWithSender } from '@/apis/group-chat';

interface GroupChatSyncManagerProps {
  taskId: number;
  isGroupChat: boolean;
  enabled?: boolean;
  onNewMessages?: (messages: SubtaskWithSender[]) => void;
  onStreamContent?: (content: string, subtaskId: number) => void;
  onStreamComplete?: (subtaskId: number, result?: Record<string, unknown>) => void;
}

/**
 * Manager component for group chat real-time synchronization
 *
 * Usage:
 * ```tsx
 * <GroupChatSyncManager
 *   taskId={currentTaskId}
 *   isGroupChat={task.isGroupChat}
 *   enabled={isActive}
 *   onNewMessages={(messages) => {
 *     // Add new messages to message list
 *     messages.forEach(msg => addMessage(msg))
 *   }}
 *   onStreamContent={(content, subtaskId) => {
 *     // Update streaming content for the subtask
 *     updateStreamingMessage(subtaskId, content)
 *   }}
 *   onStreamComplete={(subtaskId, result) => {
 *     // Mark stream as complete
 *     finalizeMessage(subtaskId, result)
 *   }}
 * />
 * ```
 */
export function GroupChatSyncManager({
  taskId,
  isGroupChat,
  enabled = true,
  onNewMessages,
  onStreamContent,
  onStreamComplete,
}: GroupChatSyncManagerProps) {
  // Polling for new messages
  const {
    streamingSubtaskId,
    error: pollingError,
    clearMessages,
  } = useGroupChatPolling({
    taskId,
    isGroupChat,
    enabled,
    pollingInterval: 1000, // 1 second
    onNewMessages,
    onStreamingDetected: subtaskId => {
      console.log('[GroupChatSync] Stream detected:', subtaskId);
    },
  });

  // Stream subscription (automatically connects when streamingSubtaskId changes)
  const { content: streamContent, error: streamError } = useGroupChatStream({
    taskId,
    subtaskId: streamingSubtaskId, // undefined means not subscribed
    offset: 0,
    onChunk: chunk => {
      if (onStreamContent && chunk.subtask_id) {
        onStreamContent(chunk.content, chunk.subtask_id);
      }
    },
    onComplete: result => {
      if (onStreamComplete && streamingSubtaskId) {
        onStreamComplete(streamingSubtaskId, result);
      }
    },
    onError: error => {
      console.error('[GroupChatSync] Stream error:', error);
    },
  });

  // Notify about streaming content updates
  useEffect(() => {
    if (streamContent && streamingSubtaskId && onStreamContent) {
      onStreamContent(streamContent, streamingSubtaskId);
    }
  }, [streamContent, streamingSubtaskId, onStreamContent]);

  // Log errors
  useEffect(() => {
    if (pollingError) {
      console.error('[GroupChatSync] Polling error:', pollingError);
    }
  }, [pollingError]);

  useEffect(() => {
    if (streamError) {
      console.error('[GroupChatSync] Stream error:', streamError);
    }
  }, [streamError]);

  // Cleanup messages when unmounting
  useEffect(() => {
    return () => {
      clearMessages();
    };
  }, [clearMessages]);

  // This component doesn't render anything - it's purely for side effects
  return null;
}
