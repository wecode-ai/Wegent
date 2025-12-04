// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat Shell API client for streaming chat.
 *
 * This module provides direct streaming chat functionality for Chat Shell type,
 * bypassing the task creation + polling flow.
 */

import { getToken } from './user';

// API base URL - uses Next.js API Route for streaming (supports SSE)
const API_BASE_URL = '/api';

/**
 * Stream data event types
 */
export interface ChatStreamData {
  /** Incremental content chunk */
  content?: string;
  /** Whether the stream is complete */
  done?: boolean;
  /** Error message if any */
  error?: string;
  /** Task ID (returned in first message) */
  task_id?: number;
  /** Subtask ID (returned in first message) */
  subtask_id?: number;
  /** Complete result when done */
  result?: {
    value: string;
  };
}

/**
 * Request parameters for streaming chat
 */
export interface StreamChatRequest {
  /** User message */
  message: string;
  /** Team ID */
  team_id: number;
  /** Task ID for multi-turn conversations (optional) */
  task_id?: number;
  /** Model ID override (optional) */
  model_id?: string;
  /** Force override bot's default model */
  force_override_bot_model?: boolean;
  /** Attachment ID for file upload (optional) */
  attachment_id?: number;
  /** Git info for record keeping (optional) */
  git_url?: string;
  git_repo?: string;
  git_repo_id?: number;
  git_domain?: string;
  branch_name?: string;
}

/**
 * Callbacks for streaming chat events
 */
export interface StreamChatCallbacks {
  /** Called for each stream event */
  onMessage: (data: ChatStreamData) => void;
  /** Called on error */
  onError: (error: Error) => void;
  /** Called when stream completes successfully */
  onComplete: (taskId: number, subtaskId: number) => void;
}

/**
 * Response from check direct chat API
 */
export interface CheckDirectChatResponse {
  supports_direct_chat: boolean;
  shell_type: string;
}

/**
 * Start a streaming chat request.
 *
 * Uses fetch + ReadableStream to handle SSE responses.
 *
 * @param request - Chat request parameters
 * @param callbacks - Event callbacks
 * @returns Object with taskId and abort function
 */
export async function streamChat(
  request: StreamChatRequest,
  callbacks: StreamChatCallbacks
): Promise<{ taskId: number; abort: () => void }> {
  const controller = new AbortController();
  const token = getToken();

  console.log('[chat.ts] streamChat called with request:', {
    message: request.message?.substring(0, 50) + '...',
    team_id: request.team_id,
    task_id: request.task_id,
    model_id: request.model_id,
  });

  try {
    // Use Next.js API Route for streaming (supports SSE via route.ts)
    console.log('[chat.ts] Sending POST to:', `${API_BASE_URL}/chat/stream`);
    const response = await fetch(`${API_BASE_URL}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = errorText;
      try {
        const json = JSON.parse(errorText);
        if (json && typeof json.detail === 'string') {
          errorMsg = json.detail;
        }
      } catch {
        // Not JSON, use original text
      }
      throw new Error(errorMsg);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let taskId = request.task_id || 0;
    let subtaskId = 0;

    // Process stream asynchronously
    (async () => {
      try {
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');

          // Keep the last incomplete line in buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed: ChatStreamData = JSON.parse(data);

                // Save task_id and subtask_id from first message
                if (parsed.task_id) taskId = parsed.task_id;
                if (parsed.subtask_id) subtaskId = parsed.subtask_id;

                callbacks.onMessage(parsed);

                if (parsed.done) {
                  callbacks.onComplete(taskId, subtaskId);
                }

                if (parsed.error) {
                  callbacks.onError(new Error(parsed.error));
                }
              } catch (parseError) {
                // Log parse errors for debugging, but don't throw
                // This can happen if JSON is split across chunks
                console.warn('[chat.ts] Failed to parse SSE data:', {
                  line: line.substring(0, 100),
                  error: parseError,
                });
              }
            }
          }
        }

        // Process any remaining data in buffer
        if (buffer.startsWith('data: ')) {
          const data = buffer.slice(6);
          if (data && data !== '[DONE]') {
            try {
              const parsed: ChatStreamData = JSON.parse(data);
              if (parsed.task_id) taskId = parsed.task_id;
              if (parsed.subtask_id) subtaskId = parsed.subtask_id;
              callbacks.onMessage(parsed);
              if (parsed.done) {
                callbacks.onComplete(taskId, subtaskId);
              }
            } catch {
              // Ignore
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          callbacks.onError(error as Error);
        }
      }
    })();

    return {
      taskId,
      abort: () => controller.abort(),
    };
  } catch (error) {
    callbacks.onError(error as Error);
    return {
      taskId: 0,
      abort: () => {},
    };
  }
}

/**
 * Check if a team supports direct chat mode.
 *
 * @param teamId - Team ID to check
 * @returns Whether the team supports direct chat and its shell type
 */
export async function checkDirectChat(teamId: number): Promise<CheckDirectChatResponse> {
  const token = getToken();

  const response = await fetch(`${API_BASE_URL}/chat/check-direct-chat/${teamId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = errorText;
    try {
      const json = JSON.parse(errorText);
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail;
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Request parameters for cancelling a chat stream
 */
export interface CancelChatRequest {
  /** Subtask ID to cancel */
  subtask_id: number;
  /** Partial content received before cancellation (optional) */
  partial_content?: string;
}

/**
 * Response from cancel chat API
 */
export interface CancelChatResponse {
  success: boolean;
  message: string;
}

/**
 * Cancel an ongoing chat stream.
 *
 * @param request - Cancel request parameters
 * @returns Cancel result
 */
export async function cancelChat(request: CancelChatRequest): Promise<CancelChatResponse> {
  const token = getToken();

  const response = await fetch(`${API_BASE_URL}/chat/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = errorText;
    try {
      const json = JSON.parse(errorText);
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail;
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Chat API exports
 */
export const chatApis = {
  streamChat,
  checkDirectChat,
  cancelChat,
};
