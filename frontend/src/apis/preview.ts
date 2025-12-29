// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Preview API client for Workbench live preview functionality.
 */

import { apiClient } from '@/lib/api-client'
import type {
  PreviewConfigResponse,
  PreviewStartRequest,
  PreviewStartResponse,
  PreviewStopResponse,
} from '@/types/preview'

/**
 * Preview API functions
 */
export const previewApis = {
  /**
   * Get preview configuration for a task
   */
  getConfig: async (taskId: number): Promise<PreviewConfigResponse> => {
    const response = await apiClient.get<PreviewConfigResponse>(`/preview/${taskId}/config`)
    return response.data
  },

  /**
   * Start preview service for a task
   */
  start: async (taskId: number, options?: PreviewStartRequest): Promise<PreviewStartResponse> => {
    const response = await apiClient.post<PreviewStartResponse>(
      `/preview/${taskId}/start`,
      options || {}
    )
    return response.data
  },

  /**
   * Stop preview service for a task
   */
  stop: async (taskId: number): Promise<PreviewStopResponse> => {
    const response = await apiClient.post<PreviewStopResponse>(`/preview/${taskId}/stop`)
    return response.data
  },
}
