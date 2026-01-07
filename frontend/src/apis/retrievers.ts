// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import { UnifiedModel, UnifiedModelListResponse } from './models'

// Retriever CRD Types
export interface IndexStrategy {
  mode: string // 'fixed', 'rolling', 'per_dataset'
  fixedName?: string
  rollingStep?: number
  prefix?: string
}

export interface StorageConfig {
  type: string // 'elasticsearch' or 'qdrant'
  url: string
  username?: string
  password?: string
  apiKey?: string
  indexStrategy: IndexStrategy
  ext?: Record<string, unknown>
}

export interface RetrievalMethod {
  enabled: boolean
  defaultWeight?: number
}

export interface RetrieverSpec {
  storageConfig: StorageConfig
  retrievalMethods?: Record<string, RetrievalMethod>
  description?: string
}

export interface RetrieverCRD {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace: string
    displayName?: string
  }
  spec: RetrieverSpec
}

export interface RetrieverListResponse {
  data: UnifiedRetriever[]
}

// Unified Retriever Types (for list API)
export type RetrieverTypeEnum = 'user' | 'group' | 'public'

export interface UnifiedRetriever {
  name: string
  type: RetrieverTypeEnum
  displayName?: string
  storageType: string // 'elasticsearch' | 'qdrant'
  namespace: string
  description?: string
}

// Test Connection Types
export interface TestConnectionRequest {
  storage_type: 'elasticsearch' | 'qdrant'
  url: string
  username?: string
  password?: string
  api_key?: string
}

export interface TestConnectionResponse {
  success: boolean
  message: string
}

// Storage Retrieval Methods Types
export type RetrievalMethodType = 'vector' | 'keyword' | 'hybrid'

export interface StorageRetrievalMethodsResponse {
  data: Record<string, RetrievalMethodType[]>
  storage_types: string[]
}

export interface StorageTypeRetrievalMethodsResponse {
  storage_type: string
  retrieval_methods: RetrievalMethodType[]
}

// Retriever Services
export const retrieverApis = {
  /**
   * Get unified list of all available retrievers
   *
   * @param scope - Resource scope: 'personal', 'group', or 'all'
   * @param groupName - Group name (required when scope is 'group')
   */
  async getUnifiedRetrievers(
    scope?: 'personal' | 'group' | 'all',
    groupName?: string
  ): Promise<RetrieverListResponse> {
    const params = new URLSearchParams()
    if (scope) {
      params.append('scope', scope)
    }
    if (groupName) {
      params.append('group_name', groupName)
    }
    const queryString = params.toString()
    return apiClient.get(`/retrievers${queryString ? `?${queryString}` : ''}`)
  },

  /**
   * Get a single retriever by name
   * @param name - Retriever name
   * @param namespace - Namespace (default: 'default')
   */
  async getRetriever(name: string, namespace: string = 'default'): Promise<RetrieverCRD> {
    return apiClient.get(
      `/retrievers/${encodeURIComponent(name)}?namespace=${encodeURIComponent(namespace)}`
    )
  },

  /**
   * Create a new retriever
   * @param retriever - Retriever CRD data
   */
  async createRetriever(retriever: RetrieverCRD): Promise<RetrieverCRD> {
    return apiClient.post('/retrievers', retriever)
  },

  /**
   * Update an existing retriever
   * @param name - Retriever name
   * @param retriever - Updated Retriever CRD data
   */
  async updateRetriever(name: string, retriever: RetrieverCRD): Promise<RetrieverCRD> {
    return apiClient.put(`/retrievers/${encodeURIComponent(name)}`, retriever)
  },

  /**
   * Delete a retriever
   * @param name - Retriever name
   * @param namespace - Namespace (default: 'default')
   */
  async deleteRetriever(name: string, namespace: string = 'default'): Promise<void> {
    return apiClient.delete(
      `/retrievers/${encodeURIComponent(name)}?namespace=${encodeURIComponent(namespace)}`
    )
  },

  /**
   * Test retriever storage connection
   */
  async testConnection(config: TestConnectionRequest): Promise<TestConnectionResponse> {
    return apiClient.post('/retrievers/test-connection', config)
  },

  /**
   * Get supported retrieval methods for all storage types
   *
   * Returns a mapping of storage type to supported retrieval methods.
   * Example: { elasticsearch: ['vector', 'keyword', 'hybrid'], qdrant: ['vector'] }
   */
  async getStorageRetrievalMethods(): Promise<StorageRetrievalMethodsResponse> {
    return apiClient.get('/retrievers/storage-types/retrieval-methods')
  },

  /**
   * Get supported retrieval methods for a specific storage type
   *
   * @param storageType - Storage type name (e.g., 'elasticsearch', 'qdrant')
   */
  async getStorageTypeRetrievalMethods(
    storageType: string
  ): Promise<StorageTypeRetrievalMethodsResponse> {
    return apiClient.get(
      `/retrievers/storage-types/${encodeURIComponent(storageType)}/retrieval-methods`
    )
  },

  /**
   * Get embedding models (filter models by modelType=embedding)
   */
  async getEmbeddingModels(): Promise<UnifiedModel[]> {
    const response = await apiClient.get<UnifiedModelListResponse>('/models/unified')
    const models = response?.data || []
    return models.filter((model: UnifiedModel) => model.modelCategoryType === 'embedding')
  },
}
