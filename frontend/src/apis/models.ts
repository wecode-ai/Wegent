// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

// Model CRD Types
export interface ModelCRD {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace: string
  }
  spec: {
    modelConfig: {
      env: {
        model: string // 'openai' | 'claude'
        model_id: string
        api_key: string
        base_url?: string
      }
    }
  }
  status?: {
    state: string
  }
}

export interface ModelListResponse {
  items: ModelCRD[]
  total?: number
}

// Legacy Model Types (for backward compatibility)
export interface Model {
  name: string
}

export interface ModelNamesResponse {
  data: Model[]
}

// Test Connection Types
export interface TestConnectionRequest {
  provider_type: 'openai' | 'anthropic'
  model_id: string
  api_key: string
  base_url?: string
}

export interface TestConnectionResponse {
  success: boolean
  message: string
}

// Compatible Models Types
export interface CompatibleModel {
  name: string
}

export interface CompatibleModelsResponse {
  models: CompatibleModel[]
}

// Model Services
export const modelApis = {
  /**
   * Get model names for a specific agent (legacy API)
   */
  async getModelNames(agentName: string): Promise<ModelNamesResponse> {
    return apiClient.get(`/models/names?agent_name=${encodeURIComponent(agentName)}`)
  },

  /**
   * Get all models as CRD resources
   */
  async getAllModels(): Promise<ModelListResponse> {
    return apiClient.get('/v1/namespaces/default/models')
  },

  /**
   * Get a single model by name
   */
  async getModel(name: string): Promise<ModelCRD> {
    return apiClient.get(`/v1/namespaces/default/models/${encodeURIComponent(name)}`)
  },

  /**
   * Create a new model
   */
  async createModel(model: ModelCRD): Promise<ModelCRD> {
    return apiClient.post('/v1/namespaces/default/models', model)
  },

  /**
   * Update an existing model
   */
  async updateModel(name: string, model: ModelCRD): Promise<ModelCRD> {
    return apiClient.put(`/v1/namespaces/default/models/${encodeURIComponent(name)}`, model)
  },

  /**
   * Delete a model
   */
  async deleteModel(name: string): Promise<void> {
    return apiClient.delete(`/v1/namespaces/default/models/${encodeURIComponent(name)}`)
  },

  /**
   * Test model connection
   */
  async testConnection(config: TestConnectionRequest): Promise<TestConnectionResponse> {
    return apiClient.post('/models/test-connection', config)
  },

  /**
   * Get models compatible with a specific agent type
   */
  async getCompatibleModels(agentName: string): Promise<CompatibleModelsResponse> {
    return apiClient.get(`/models/compatible?agent_name=${encodeURIComponent(agentName)}`)
  },
}
