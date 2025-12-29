// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Preview API client for Workbench live preview functionality.
 */

import { apiClient } from './client'
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
    return apiClient.get<PreviewConfigResponse>(`/preview/${taskId}/config`)
  },

  /**
   * Start preview service for a task
   */
  start: async (taskId: number, options?: PreviewStartRequest): Promise<PreviewStartResponse> => {
    return apiClient.post<PreviewStartResponse>(
      `/preview/${taskId}/start`,
      options || {}
    )
  },

  /**
   * Stop preview service for a task
   */
  stop: async (taskId: number): Promise<PreviewStopResponse> => {
    return apiClient.post<PreviewStopResponse>(`/preview/${taskId}/stop`)
  },
}
