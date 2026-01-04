// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas API client
 */

import { apiClient } from './client'

export interface CanvasResponse {
  enabled: boolean
  content: string
  file_type: string
  title: string
}

export interface EnableCanvasRequest {
  task_id: number
  initial_content?: string
  file_type?: string
  title?: string
}

export interface UpdateCanvasRequest {
  task_id: number
  content: string
  file_type?: string
  title?: string
}

export const canvasApis = {
  /**
   * Enable canvas mode for a task
   */
  async enableCanvas(request: EnableCanvasRequest): Promise<CanvasResponse> {
    const response = await apiClient.post('/canvas/enable', request)
    return response.data
  },

  /**
   * Get canvas content for a task
   */
  async getCanvas(taskId: number): Promise<CanvasResponse> {
    const response = await apiClient.get(`/canvas/${taskId}`)
    return response.data
  },

  /**
   * Update canvas content
   */
  async updateCanvas(request: UpdateCanvasRequest): Promise<CanvasResponse> {
    const response = await apiClient.put('/canvas/update', request)
    return response.data
  },

  /**
   * Disable canvas mode for a task
   */
  async disableCanvas(taskId: number): Promise<{ message: string }> {
    const response = await apiClient.post(`/canvas/${taskId}/disable`)
    return response.data
  },
}
