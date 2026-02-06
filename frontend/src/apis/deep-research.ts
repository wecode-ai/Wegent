// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Deep Research API client for Gemini Interaction API integration.
 *
 * This module provides functions to interact with the deep research endpoints
 * which proxy requests to the Gemini Interaction API for long-running research tasks.
 */

import { apiClient, ApiError } from './client'
import { getApiBaseUrl } from '@/lib/runtime-config'
import { getToken } from './user'

// ============================================================
// Types
// ============================================================

export interface DeepResearchModelConfig {
  api_key: string
  base_url: string
}

export interface DeepResearchMetadata {
  task_id?: number
  subtask_id?: number
  user_id?: number
}

export interface DeepResearchCreateRequest {
  model_config: DeepResearchModelConfig
  input: string
  agent?: string
  metadata?: DeepResearchMetadata
}

export interface DeepResearchCreateResponse {
  interaction_id: string
  status: string
  created_at: string
}

export interface DeepResearchStatusRequest {
  model_config: DeepResearchModelConfig
}

export interface DeepResearchStatusResponse {
  interaction_id: string
  status: 'in_progress' | 'completed' | 'failed' | string
  created_at?: string
  updated_at?: string
}

export interface DeepResearchStreamRequest {
  model_config: DeepResearchModelConfig
}

// SSE Event types
export type DeepResearchEventType =
  | 'response.start'
  | 'response.status_update'
  | 'content.start'
  | 'content.delta'
  | 'content.stop'
  | 'response.done'
  | 'response.error'
  | 'done'

export interface DeepResearchSSEEvent {
  event: DeepResearchEventType
  data: unknown
}

// ============================================================
// API Functions
// ============================================================

/**
 * Create a new deep research task.
 *
 * @param request - The request parameters including model config and input query
 * @returns The response with interaction_id for polling
 */
export async function createDeepResearch(
  request: DeepResearchCreateRequest
): Promise<DeepResearchCreateResponse> {
  return apiClient.post('/v1/deep-research', request)
}

/**
 * Get the status of a deep research task.
 *
 * @param interactionId - The interaction ID from create response
 * @param request - The request with model config
 * @returns The current status of the task
 */
export async function getDeepResearchStatus(
  interactionId: string,
  request: DeepResearchStatusRequest
): Promise<DeepResearchStatusResponse> {
  return apiClient.post(`/v1/deep-research/${interactionId}/status`, request)
}

/**
 * Stream the results of a completed deep research task.
 *
 * This function returns an AsyncGenerator that yields SSE events.
 *
 * @param interactionId - The interaction ID from create response
 * @param request - The request with model config
 * @param onEvent - Callback for each SSE event
 * @param signal - Optional AbortSignal for cancellation
 */
export async function streamDeepResearchResult(
  interactionId: string,
  request: DeepResearchStreamRequest,
  onEvent: (event: DeepResearchSSEEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const url = `${getApiBaseUrl()}/v1/deep-research/${interactionId}/stream`
  const token = getToken()

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(request),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new ApiError(errorText, response.status)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Response body is not readable')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Parse SSE events from buffer
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // Keep incomplete line in buffer

      let currentEvent: DeepResearchEventType | null = null
      let currentData = ''

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim() as DeepResearchEventType
        } else if (line.startsWith('data: ')) {
          currentData = line.slice(6)
        } else if (line === '' && currentEvent && currentData) {
          // Empty line indicates end of event
          try {
            const data = JSON.parse(currentData)
            onEvent({ event: currentEvent, data })
          } catch (_e) {
            // If data is not JSON, pass as string
            onEvent({ event: currentEvent, data: currentData })
          }
          currentEvent = null
          currentData = ''
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Poll deep research status until completion.
 *
 * @param interactionId - The interaction ID to poll
 * @param modelConfig - Model configuration for API calls
 * @param options - Polling options (interval, timeout, onStatus callback)
 * @returns The final status response
 */
export async function pollDeepResearchStatus(
  interactionId: string,
  modelConfig: DeepResearchModelConfig,
  options: {
    intervalMs?: number
    timeoutMs?: number
    onStatus?: (status: DeepResearchStatusResponse) => void
    signal?: AbortSignal
  } = {}
): Promise<DeepResearchStatusResponse> {
  const { intervalMs = 5000, timeoutMs = 3600000, onStatus, signal } = options // default: 5s interval, 1hr timeout

  const startTime = Date.now()

  while (true) {
    // Check for abort
    if (signal?.aborted) {
      throw new Error('Polling aborted')
    }

    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      throw new Error('Polling timeout exceeded')
    }

    const status = await getDeepResearchStatus(interactionId, { model_config: modelConfig })

    // Callback with current status
    if (onStatus) {
      onStatus(status)
    }

    // Check if completed
    if (status.status === 'completed' || status.status === 'failed') {
      return status
    }

    // Wait before next poll
    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(resolve, intervalMs)
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeoutId)
            reject(new Error('Polling aborted'))
          },
          { once: true }
        )
      }
    })
  }
}

// Export as namespace for grouped access
export const deepResearchApis = {
  create: createDeepResearch,
  getStatus: getDeepResearchStatus,
  stream: streamDeepResearchResult,
  pollStatus: pollDeepResearchStatus,
}
