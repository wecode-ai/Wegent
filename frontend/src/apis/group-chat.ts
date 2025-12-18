// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Group chat API client for real-time message synchronization
 */

import client from './client';

/**
 * Subtask with sender information
 */
export interface SubtaskWithSender {
  id: number;
  task_id: number;
  team_id: number;
  title: string;
  role: 'USER' | 'ASSISTANT';
  prompt?: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progress: number;
  result?: Record<string, unknown>;
  error_message?: string;
  sender_type?: 'USER' | 'TEAM';
  sender_user_id?: number;
  sender_username?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

/**
 * Poll messages response
 */
export interface PollMessagesResponse {
  messages: SubtaskWithSender[];
  has_streaming: boolean;
  streaming_subtask_id?: number;
}

/**
 * Streaming status response
 */
export interface StreamingStatus {
  is_streaming: boolean;
  subtask_id?: number;
  started_by_user_id?: number;
  started_by_username?: string;
  current_content?: string;
  started_at?: string;
}

/**
 * Poll for new messages in a group chat task
 *
 * @param taskId - Task ID
 * @param lastSubtaskId - Last subtask ID received (optional)
 * @param since - ISO timestamp to filter messages (optional)
 * @returns Promise with new messages and streaming status
 */
export async function pollNewMessages(
  taskId: number,
  lastSubtaskId?: number,
  since?: string
): Promise<PollMessagesResponse> {
  const params = new URLSearchParams();
  if (lastSubtaskId !== undefined) {
    params.append('last_subtask_id', lastSubtaskId.toString());
  }
  if (since) {
    params.append('since', since);
  }

  // client.get returns the data directly, not wrapped in { data: ... }
  return client.get<PollMessagesResponse>(
    `/subtasks/tasks/${taskId}/messages/poll?${params.toString()}`
  );
}

/**
 * Get current streaming status for a task
 *
 * @param taskId - Task ID
 * @returns Promise with streaming status
 */
export async function getStreamingStatus(taskId: number): Promise<StreamingStatus> {
  // client.get returns the data directly, not wrapped in { data: ... }
  return client.get<StreamingStatus>(`/subtasks/tasks/${taskId}/streaming-status`);
}

/**
 * Subscribe to a group chat stream via SSE
 *
 * @param taskId - Task ID
 * @param subtaskId - Subtask ID to subscribe to
 * @param offset - Character offset for resuming (optional)
 * @returns EventSource instance
 */
export function subscribeGroupStream(
  taskId: number,
  subtaskId: number,
  offset: number = 0
): EventSource {
  const params = new URLSearchParams({
    subtask_id: subtaskId.toString(),
    offset: offset.toString(),
  });

  const url = `/api/subtasks/tasks/${taskId}/stream/subscribe?${params.toString()}`;

  return new EventSource(url, {
    withCredentials: true,
  });
}
