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
  /** Character offset for this chunk (for offset-based streaming) */
  offset?: number;
  /** Whether this is cached content (from resume) */
  cached?: boolean;
  /** Whether stream was cancelled */
  cancelled?: boolean;
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
  /** Enable web search for this message */
  enable_web_search?: boolean;
  /** Search engine to use (when web search is enabled) */
  search_engine?: string;
  /** Enable clarification mode for this message */
  enable_clarification?: boolean;
  /** Git info for record keeping (optional) */
  git_url?: string;
  git_repo?: string;
  git_repo_id?: number;
  git_domain?: string;
  branch_name?: string;
  /** Subtask ID for resuming an existing stream (optional) */
  subtask_id?: number;
  /** Character offset for resuming (0 = send all cached content) */
  offset?: number;
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

    // Get task_id and subtask_id from response headers (available immediately)
    const headerTaskId = response.headers.get('X-Task-Id');
    const headerSubtaskId = response.headers.get('X-Subtask-Id');

    let taskId = headerTaskId ? parseInt(headerTaskId, 10) : request.task_id || 0;
    let subtaskId = headerSubtaskId ? parseInt(headerSubtaskId, 10) : 0;

    console.log('[chat.ts] Got task_id from headers:', taskId, 'subtask_id:', subtaskId);

    // If we got task_id from headers, immediately notify via onMessage
    // This allows the caller to update state before streaming starts
    if (headerTaskId && !request.task_id) {
      callbacks.onMessage({
        task_id: taskId,
        subtask_id: subtaskId,
        content: '',
        done: false,
      });
    }

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
              } catch {
                // Ignore parse errors for incomplete chunks
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
 * Response from get streaming content API
 */
export interface StreamingContentResponse {
  /** The accumulated content */
  content: string;
  /** Source of the content: "redis" (most recent) or "database" (fallback) */
  source: 'redis' | 'database';
  /** Whether still streaming */
  streaming: boolean;
  /** Subtask status */
  status: string;
  /** Whether content is incomplete (client disconnected) */
  incomplete: boolean;
}

/**
 * Get streaming content for a subtask (for recovery on refresh).
 *
 * This endpoint tries to get the most recent content from:
 * 1. Redis streaming cache (most recent, updated every 1 second)
 * 2. Database result field (fallback, updated every 5 seconds)
 *
 * @param subtaskId - Subtask ID to get content for
 * @returns Streaming content and metadata
 */
export async function getStreamingContent(subtaskId: number): Promise<StreamingContentResponse> {
  const token = getToken();

  const response = await fetch(`${API_BASE_URL}/chat/streaming-content/${subtaskId}`, {
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
 * Resume streaming for a running subtask after page refresh.
 * Returns an EventSource-like stream that continues from where it left off.
 *
 * @deprecated Use resumeStreamWithOffset instead for offset-based streaming
 * @param subtaskId - Subtask ID to resume streaming for
 * @returns EventSource for receiving streaming updates
 */
export function resumeStream(subtaskId: number): EventSource {
  return new EventSource(`/api/chat/resume-stream/${subtaskId}`);
}

/**
 * Resume streaming using the unified stream endpoint with offset-based continuation.
 *
 * This is the preferred method for resuming streams as it:
 * - Uses the same endpoint as new streams
 * - Supports offset-based continuation (no duplicate data)
 * - Provides offset information in each chunk for tracking
 *
 * @param subtaskId - Subtask ID to resume
 * @param offset - Character offset to resume from (0 = send all cached content)
 * @param teamId - Team ID (required for the stream endpoint)
 * @param callbacks - Event callbacks
 * @returns Object with abort function
 */
export async function resumeStreamWithOffset(
  subtaskId: number,
  offset: number,
  teamId: number,
  callbacks: StreamChatCallbacks
): Promise<{ abort: () => void }> {
  // Use the unified stream endpoint with resume parameters
  const request: StreamChatRequest = {
    message: '', // Empty message for resume
    team_id: teamId,
    subtask_id: subtaskId,
    offset: offset,
  };

  const result = await streamChat(request, callbacks);
  return { abort: result.abort };
}

/**
 * Search engine information
 */
export interface SearchEngine {
  name: string;
  display_name: string;
}

/**
 * Response from get search engines API
 */
export interface SearchEnginesResponse {
  enabled: boolean;
  engines: SearchEngine[];
}

/**
 * Get available search engines from backend configuration.
 *
 * @returns Search engines configuration
 */
export async function getSearchEngines(): Promise<SearchEnginesResponse> {
  const token = getToken();

  const response = await fetch(`${API_BASE_URL}/chat/search-engines`, {
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
 * Chat API exports
 */
export const chatApis = {
  streamChat,
  checkDirectChat,
  cancelChat,
  getStreamingContent,
  resumeStream,
  resumeStreamWithOffset,
  getSearchEngines,
};
