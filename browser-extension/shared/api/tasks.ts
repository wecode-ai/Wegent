// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tasks API
 */

import { apiRequest } from './client'
import type {
  TaskCreate,
  TaskResponse,
  ResponseCreateInput,
  ResponseObject,
  UnifiedModel,
} from './types'

/**
 * Create a new task ID (pre-allocate)
 */
export async function createTaskId(): Promise<{ task_id: number }> {
  return apiRequest<{ task_id: number }>('/tasks', {
    method: 'POST',
  })
}

/**
 * Create a new task with optional pre-allocated ID
 */
export async function createTask(
  taskId: number,
  data: TaskCreate,
): Promise<TaskResponse> {
  return apiRequest<TaskResponse>(`/tasks/${taskId}`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * Create task with auto-generated ID
 */
export async function createTaskAuto(data: TaskCreate): Promise<TaskResponse> {
  return apiRequest<TaskResponse>('/tasks/create', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * Get task details
 */
export async function getTask(taskId: number): Promise<TaskResponse> {
  return apiRequest<TaskResponse>(`/tasks/${taskId}`)
}

/**
 * Create a response using OpenAPI v1/responses endpoint.
 * This is the recommended way to create tasks for Chat Shell type teams.
 *
 * @param data - ResponseCreateInput containing model, input, and optional settings
 * @returns ResponseObject with task ID and status
 */
export async function createResponse(data: ResponseCreateInput): Promise<ResponseObject> {
  return apiRequest<ResponseObject>('/v1/responses', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * Get response details by response ID
 *
 * @param responseId - Response ID in format "resp_{task_id}"
 * @returns ResponseObject with current status and output
 */
export async function getResponse(responseId: string): Promise<ResponseObject> {
  return apiRequest<ResponseObject>(`/v1/responses/${responseId}`)
}

/**
 * Extract task ID from response ID
 *
 * @param responseId - Response ID in format "resp_{task_id}"
 * @returns Task ID as number
 */
export function extractTaskIdFromResponseId(responseId: string): number {
  if (!responseId.startsWith('resp_')) {
    throw new Error(`Invalid response ID format: ${responseId}`)
  }
  return parseInt(responseId.slice(5), 10)
}

/**
 * Get unified list of available models (both public and user-defined)
 *
 * @param shellType - Optional shell type to filter compatible models (e.g., 'Chat')
 * @returns List of unified models
 */
export async function getUnifiedModels(shellType?: string): Promise<UnifiedModel[]> {
  const params = new URLSearchParams()
  if (shellType) {
    params.append('shell_type', shellType)
  }
  const queryString = params.toString()
  const endpoint = `/models/unified${queryString ? `?${queryString}` : ''}`
  const response = await apiRequest<{ data: UnifiedModel[] }>(endpoint)
  return response.data
}
