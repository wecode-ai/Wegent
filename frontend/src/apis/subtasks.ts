// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from './client'

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

export const subtaskApis = {
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
