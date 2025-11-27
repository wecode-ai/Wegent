// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client';

// Model Types
export interface Model {
  name: string;
}

export interface ModelCRD {
  metadata: {
    name: string;
    namespace: string;
  };
  spec: {
    modelConfig: {
      env: {
        model: 'openai' | 'claude';
        model_id: string;
        api_key: string;
        base_url?: string;
      };
    };
  };
  status: {
    state: string;
  };
}

export interface ModelNamesResponse {
  data: Model[];
}

// Model Services
export const modelApis = {
  async getModelNames(agentName: string): Promise<ModelNamesResponse> {
    return apiClient.get(`/models/names?agent_name=${encodeURIComponent(agentName)}`);
  },

  /**
   * Get compatible models for specified agent
   */
  async fetchCompatibleModels(agentName: string): Promise<Array<{ name: string }>> {
    const response = await apiClient.get(
      `/models/compatible?agent_name=${encodeURIComponent(agentName)}`
    );
    return response.models;
  },

  /**
   * Test model connection
   */
  async testModelConnection(config: {
    provider_type: 'openai' | 'anthropic';
    model_id: string;
    api_key: string;
    base_url?: string;
  }): Promise<{ success: boolean; message: string }> {
    return apiClient.post('/models/test-connection', config);
  },

  /**
   * Get all models list
   */
  async fetchAllModels(): Promise<ModelCRD[]> {
    const response = await apiClient.get('/kinds/namespaces/default/models');
    return response.items || [];
  },

  /**
   * Create model
   */
  async createModel(model: ModelCRD): Promise<ModelCRD> {
    return apiClient.post('/kinds/namespaces/default/models', model);
  },

  /**
   * Update model
   */
  async updateModel(name: string, model: ModelCRD): Promise<ModelCRD> {
    return apiClient.put(`/kinds/namespaces/default/models/${name}`, model);
  },

  /**
   * Delete model
   */
  async deleteModel(name: string): Promise<void> {
    await apiClient.delete(`/kinds/namespaces/default/models/${name}`);
  },
};
