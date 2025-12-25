// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from './client'

// Types for grey (beta) test API
export interface GreyStatusResponse {
  is_grey_user: boolean
}

export interface GreyActionResponse {
  success: boolean
  is_grey_user: boolean
}

/**
 * Grey (Beta) test API functions
 */
export const greyApis = {
  /**
   * Get current user's grey (beta) test status
   */
  getStatus: async (): Promise<GreyStatusResponse> => {
    return apiClient.get<GreyStatusResponse>('/grey/status')
  },

  /**
   * Join the grey (beta) test program
   */
  join: async (): Promise<GreyActionResponse> => {
    return apiClient.post<GreyActionResponse>('/grey/join')
  },

  /**
   * Leave the grey (beta) test program
   */
  leave: async (): Promise<GreyActionResponse> => {
    return apiClient.post<GreyActionResponse>('/grey/leave')
  },
}
