// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat Shell API client.
 *
 * NOTE: Streaming chat now uses WebSocket via ChatStreamContext.
 * This module provides utility functions for chat operations.
 */

import { getToken } from './user'

// API base URL - uses Next.js API Route
const API_BASE_URL = '/api'

/**
 * Response from check direct chat API
 */
export interface CheckDirectChatResponse {
  supports_direct_chat: boolean
  shell_type: string
}

/**
 * Check if a team supports direct chat mode.
 *
 * @param teamId - Team ID to check
 * @returns Whether the team supports direct chat and its shell type
 */
export async function checkDirectChat(teamId: number): Promise<CheckDirectChatResponse> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/chat/check-direct-chat/${teamId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errorMsg = errorText
    try {
      const json = JSON.parse(errorText)
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg)
  }

  return response.json()
}

/**
 * Request parameters for cancelling a chat stream
 */
export interface CancelChatRequest {
  /** Subtask ID to cancel */
  subtask_id: number
  /** Partial content received before cancellation (optional) */
  partial_content?: string
}

/**
 * Response from cancel chat API
 */
export interface CancelChatResponse {
  success: boolean
  message: string
}

/**
 * Cancel an ongoing chat stream via HTTP API.
 *
 * @deprecated This function is deprecated. Use WebSocket-based cancellation via
 * `cancelChatStream` from `SocketContext` instead, which provides better performance
 * and real-time feedback. This HTTP-based implementation is kept for fallback scenarios
 * but will be removed in a future version.
 *
 * @param request - Cancel request parameters
 * @returns Cancel result
 */
export async function cancelChat(request: CancelChatRequest): Promise<CancelChatResponse> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/chat/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errorMsg = errorText
    try {
      const json = JSON.parse(errorText)
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg)
  }

  return response.json()
}

/**
 * Response from get streaming content API
 */
export interface StreamingContentResponse {
  /** The accumulated content */
  content: string
  /** Source of the content: "redis" (most recent) or "database" (fallback) */
  source: 'redis' | 'database'
  /** Whether still streaming */
  streaming: boolean
  /** Subtask status */
  status: string
  /** Whether content is incomplete (client disconnected) */
  incomplete: boolean
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
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/chat/streaming-content/${subtaskId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errorMsg = errorText
    try {
      const json = JSON.parse(errorText)
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg)
  }

  return response.json()
}

/**
 * Data structure for chat stream events
 */
export interface ChatStreamData {
  /** Content chunk */
  content?: string
  /** Whether stream is done */
  done?: boolean
  /** Whether this is cached content */
  cached?: boolean
  /** Current offset in the stream */
  offset?: number
  /** Error message if any */
  error?: string
}

/**
 * Callbacks for stream handling
 */
export interface StreamCallbacks {
  /** Called when a message chunk is received */
  onMessage: (data: ChatStreamData) => void
  /** Called when an error occurs */
  onError: (error: Error) => void
  /** Called when stream completes */
  onComplete: () => void
}

/**
 * Resume streaming with offset-based continuation.
 *
 * @deprecated This SSE-based resume-stream function is deprecated. Chat streaming now uses
 * WebSocket via the global Socket.IO connection. For stream recovery, use the
 * `getStreamingContent` API to fetch accumulated content, then reconnect via WebSocket.
 * This function is kept for backward compatibility but will be removed in a future version.
 *
 * @param subtaskId - Subtask ID to resume streaming for
 * @param offset - Character offset to resume from
 * @param teamId - Team ID (currently unused but kept for API compatibility)
 * @param callbacks - Stream event callbacks
 * @returns Object with abort function to cancel the stream
 */
export async function resumeStreamWithOffset(
  subtaskId: number,
  offset: number,
  _teamId: number,
  callbacks: StreamCallbacks
): Promise<{ abort: () => void }> {
  const token = getToken()
  const controller = new AbortController()

  const fetchStream = async () => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/chat/resume-stream/${subtaskId}?offset=${offset}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'text/event-stream',
            ...(token && { Authorization: `Bearer ${token}` }),
          },
          signal: controller.signal,
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body')
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          callbacks.onComplete()
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6)
            if (dataStr === '[DONE]') {
              callbacks.onMessage({ done: true })
              callbacks.onComplete()
              return
            }
            try {
              const data = JSON.parse(dataStr) as ChatStreamData
              callbacks.onMessage(data)
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        callbacks.onError(error as Error)
      }
    }
  }

  // Start the stream
  fetchStream()

  return {
    abort: () => controller.abort(),
  }
}

/**
 * Search engine information
 */
export interface SearchEngine {
  name: string
  display_name: string
}

/**
 * Response from get search engines API
 */
export interface SearchEnginesResponse {
  enabled: boolean
  engines: SearchEngine[]
}

/**
 * Get available search engines from backend configuration.
 *
 * @returns Search engines configuration
 */
export async function getSearchEngines(): Promise<SearchEnginesResponse> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/chat/search-engines`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errorMsg = errorText
    try {
      const json = JSON.parse(errorText)
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg)
  }

  return response.json()
}

/**
 * Chat API exports
 */
export const chatApis = {
  checkDirectChat,
  cancelChat,
  getStreamingContent,
  getSearchEngines,
  resumeStreamWithOffset,
}
