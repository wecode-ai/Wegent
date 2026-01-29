// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tasks API
 */

import { apiRequest } from './client'
import type { TaskCreate, TaskResponse } from './types'

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
