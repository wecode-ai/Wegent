// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from './client'
import type { TaskDetailSubtask } from '@/types/api'

export interface MessageEditRequest {
  new_content: string
}

export interface MessageEditResponse {
  success: boolean
  subtask_id: number
  message_id: number
  deleted_count: number
  new_content: string
}

export interface SubtaskListResponse {
  total: number
  items: TaskDetailSubtask[]
}

export interface ListSubtasksParams {
  taskId: number
  page?: number
  limit?: number
  fromLatest?: boolean
  beforeMessageId?: number
}

export const subtaskApis = {
  /**
   * Get subtasks for a specific task (paginated).
   * By default (fromLatest=true), returns the latest N messages.
   * Use beforeMessageId to load older messages when scrolling up.
   *
   * @param params - Query parameters
   * @returns Paginated list of subtasks
   */
  listSubtasks: async (params: ListSubtasksParams): Promise<SubtaskListResponse> => {
    const queryParams = new URLSearchParams()
    queryParams.set('task_id', params.taskId.toString())
    if (params.page !== undefined) queryParams.set('page', params.page.toString())
    if (params.limit !== undefined) queryParams.set('limit', params.limit.toString())
    if (params.fromLatest !== undefined)
      queryParams.set('from_latest', params.fromLatest.toString())
    if (params.beforeMessageId !== undefined)
      queryParams.set('before_message_id', params.beforeMessageId.toString())

    return apiClient.get<SubtaskListResponse>(`/subtasks?${queryParams.toString()}`)
  },

  /**
   * Edit a user message and delete all subsequent messages.
   * This implements ChatGPT-style message editing.
   *
   * @param subtaskId - The subtask ID of the message to edit
   * @param newContent - The new message content
   * @returns The edit response with deleted count
   */
  editMessage: async (subtaskId: number, newContent: string): Promise<MessageEditResponse> => {
    return apiClient.post<MessageEditResponse>(`/subtasks/${subtaskId}/edit`, {
      new_content: newContent,
    })
  },
}
