// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

// API Key types
export interface ApiKey {
  id: number
  name: string
  key_prefix: string
  description?: string | null
  expires_at: string
  last_used_at: string
  created_at: string
  is_active: boolean
}

export interface ApiKeyCreated extends ApiKey {
  key: string // Full key, only at creation
}

export interface ApiKeyCreateRequest {
  name: string
  description?: string
}

export interface ApiKeyListResponse {
  items: ApiKey[]
  total: number
}

// API Key APIs
export const apiKeyApis = {
  /**
   * Get all API keys for the current user
   */
  async getApiKeys(): Promise<ApiKeyListResponse> {
    return apiClient.get('/api-keys')
  },

  /**
   * Create a new API key
   * The full key is only returned at creation time
   */
  async createApiKey(data: ApiKeyCreateRequest): Promise<ApiKeyCreated> {
    return apiClient.post('/api-keys', data)
  },

  /**
   * Toggle API key active status
   */
  async toggleApiKeyStatus(keyId: number): Promise<ApiKey> {
    return apiClient.post(`/api-keys/${keyId}/toggle-status`)
  },

  /**
   * Delete an API key
   */
  async deleteApiKey(keyId: number): Promise<void> {
    return apiClient.delete(`/api-keys/${keyId}`)
  },
}
