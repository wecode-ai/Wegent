// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

// Model Types
export interface Model {
  name: string
}

export interface ModelDetail {
  id: number
  name: string
  config: {
    env: {
      model: string        // Provider type (claude, openai, etc.)
      model_id: string
      api_key: string
      base_url?: string
      [key: string]: any   // Other provider-specific fields
    }
  }
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ModelNamesResponse {
  data: Model[]
}

export interface ModelListResponse {
  total: number
  items: ModelDetail[]
}

export interface ModelCreateRequest {
  name: string
  config: {
    env: Record<string, any>
  }
  is_active?: boolean
}

export interface TestConnectionRequest {
  provider: string
  config: {
    env: Record<string, any>
  }
}

export interface CheckReferencesResponse {
  is_referenced: boolean
  referenced_by: Array<{
    bot_id: number
    bot_name: string
  }>
}

// Model Services
export const modelApis = {
  async getModelNames(agentName: string): Promise<ModelNamesResponse> {
    return apiClient.get(`/models/names?agent_name=${encodeURIComponent(agentName)}`)
  },

  async getModels(page: number = 1, limit: number = 50): Promise<ModelListResponse> {
    return apiClient.get(`/models?page=${page}&limit=${limit}`)
  },

  async getModelById(id: number): Promise<ModelDetail> {
    return apiClient.get(`/models/${id}`)
  },

  async createModel(data: ModelCreateRequest): Promise<ModelDetail> {
    return apiClient.post('/models', data)
  },

  async updateModel(id: number, data: ModelCreateRequest): Promise<ModelDetail> {
    return apiClient.put(`/models/${id}`, data)
  },

  async deleteModel(id: number): Promise<void> {
    return apiClient.delete(`/models/${id}`)
  },

  async testConnection(data: TestConnectionRequest): Promise<{ success: boolean; message: string }> {
    return apiClient.post('/models/test', data)
  },

  async checkReferences(id: number): Promise<CheckReferencesResponse> {
    return apiClient.get(`/models/${id}/check-references`)
  }
}