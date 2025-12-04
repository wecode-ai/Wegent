// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client';

// Model CRD Types
export interface ModelCRD {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace: string;
    displayName?: string; // Human-readable display name
  };
  spec: {
    modelConfig: {
      env: {
        model: string; // 'openai' | 'claude'
        model_id: string;
        api_key: string;
        base_url?: string;
        custom_headers?: Record<string, string>; // Custom HTTP headers to override defaults
      };
    };
  };
  status?: {
    state: string;
  };
}

export interface ModelListResponse {
  items: ModelCRD[];
  total?: number;
}

// Public Model Types
export interface PublicModelItem {
  id: number;
  name: string;
  config: {
    env?: {
      model?: string;
      model_id?: string;
      api_key?: string;
      base_url?: string;
      custom_headers?: Record<string, string>; // Custom HTTP headers to override defaults
    };
  };
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PublicModelListResponse {
  total: number;
  items: PublicModelItem[];
}

// Legacy Model Types (for backward compatibility)
export interface Model {
  name: string;
  displayName?: string | null;
}

export interface ModelNamesResponse {
  data: Model[];
}

// Unified Model Types (new API with type differentiation)
export type ModelTypeEnum = 'public' | 'user';

export interface UnifiedModel {
  name: string;
  type: ModelTypeEnum; // 'public' or 'user' - identifies model source
  displayName?: string | null;
  provider?: string | null; // 'openai' | 'claude'
  modelId?: string | null;
  config?: Record<string, unknown>;
  isActive?: boolean;
}

export interface UnifiedModelListResponse {
  data: UnifiedModel[];
}

// Test Connection Types
export interface TestConnectionRequest {
  provider_type: 'openai' | 'anthropic' | 'gemini';
  model_id: string;
  api_key: string;
  base_url?: string;
}

export interface TestConnectionResponse {
  success: boolean;
  message: string;
}

// Compatible Models Types
export interface CompatibleModel {
  name: string;
}

export interface CompatibleModelsResponse {
  models: CompatibleModel[];
}

// Model Services
// Model Services
export const modelApis = {
  /**
   * Get model names for a specific shell type (legacy API, use getUnifiedModels for new implementations)
   */
  async getModelNames(shellType: string): Promise<ModelNamesResponse> {
    return apiClient.get(`/models/names?shell_type=${encodeURIComponent(shellType)}`);
  },

  /**
   * Get unified list of all available models (both public and user-defined)
   *
   * This is the recommended API for new implementations.
   * Each model includes a 'type' field ('public' or 'user') to identify its source.
   *
   * @param shellType - Optional shell type to filter compatible models
   * @param includeConfig - Whether to include full model config in response
   */
  async getUnifiedModels(
    shellType?: string,
    includeConfig: boolean = false
  ): Promise<UnifiedModelListResponse> {
    const params = new URLSearchParams();
    if (shellType) {
      params.append('shell_type', shellType);
    }
    if (includeConfig) {
      params.append('include_config', 'true');
    }
    const queryString = params.toString();
    return apiClient.get(`/models/unified${queryString ? `?${queryString}` : ''}`);
  },

  /**
   * Get a specific model by name and optional type
   *
   * @param modelName - Model name
   * @param modelType - Optional model type ('public' or 'user')
   */
  async getUnifiedModel(modelName: string, modelType?: ModelTypeEnum): Promise<UnifiedModel> {
    const params = new URLSearchParams();
    if (modelType) {
      params.append('model_type', modelType);
    }
    const queryString = params.toString();
    return apiClient.get(
      `/models/unified/${encodeURIComponent(modelName)}${queryString ? `?${queryString}` : ''}`
    );
  },
  /**
   * Get all models as CRD resources (user's own models)
   */
  async getAllModels(): Promise<ModelListResponse> {
    return apiClient.get('/v1/namespaces/default/models');
  },

  /**
   * Get all public models
   */
  async getPublicModels(page: number = 1, limit: number = 100): Promise<PublicModelListResponse> {
    return apiClient.get(`/models?page=${page}&limit=${limit}`);
  },

  /**
   * Get a single model by name
   */
  async getModel(name: string): Promise<ModelCRD> {
    return apiClient.get(`/v1/namespaces/default/models/${encodeURIComponent(name)}`);
  },

  /**
   * Create a new model
   */
  async createModel(model: ModelCRD): Promise<ModelCRD> {
    return apiClient.post('/v1/namespaces/default/models', model);
  },

  /**
   * Update an existing model
   */
  async updateModel(name: string, model: ModelCRD): Promise<ModelCRD> {
    return apiClient.put(`/v1/namespaces/default/models/${encodeURIComponent(name)}`, model);
  },

  /**
   * Delete a model
   */
  async deleteModel(name: string): Promise<void> {
    return apiClient.delete(`/v1/namespaces/default/models/${encodeURIComponent(name)}`);
  },

  /**
   * Test model connection
   */
  async testConnection(config: TestConnectionRequest): Promise<TestConnectionResponse> {
    return apiClient.post('/models/test-connection', config);
  },

  /**
   * Get models compatible with a specific shell type
   */
  async getCompatibleModels(shellType: string): Promise<CompatibleModelsResponse> {
    return apiClient.get(`/models/compatible?shell_type=${encodeURIComponent(shellType)}`);
  },
};
