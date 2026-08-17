// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

// Model Category Type (different from resource type public/user/group)
export type ModelCategoryType = 'llm' | 'tts' | 'stt' | 'embedding' | 'rerank' | 'video' | 'image'

// Type-specific configurations
export interface TTSConfig {
  voice?: string
  speed?: number
  output_format?: 'mp3' | 'wav'
}

export interface STTConfig {
  language?: string
  transcription_format?: 'text' | 'srt' | 'vtt'
}

export interface EmbeddingConfig {
  dimensions?: number
  encoding_format?: 'float' | 'base64'
  // Additional modalities beyond the implicit text default. Omit or use []
  // for text-only models.
  additional_input_modalities?: string[]
}

export interface RerankConfig {
  top_n?: number
  return_documents?: boolean
}

export interface ModelCapabilities {
  supportsImage?: boolean
  supportsVideo?: boolean
}

export interface VisionSidecarModelRef {
  modelName: string
  modelType: ModelTypeEnum
  namespace: string
  resourceUserId: number
  apiFormat: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages'
}

export interface AspectRatioOption {
  label: string
  value: string
}

export interface ResolutionOption {
  width?: number
  height?: number
  label: string
  value?: string
  tooltip?: string
}

export interface VideoGenerationMode {
  id: string
  label: string
  max_images?: number
  max_videos?: number
  max_audios?: number
  max_total?: number
  max_images_first_last?: number
  image_required?: boolean
  first_frame_required?: boolean
  audio_allowed?: boolean
  video_allowed?: boolean
}

export interface VideoCapabilities {
  aspect_ratios?: AspectRatioOption[]
  resolutions?: ResolutionOption[]
  durations_sec?: number[]
  supports_image_input?: boolean
  supports_video_input?: boolean
  supports_audio_input?: boolean
  generate_audio?: boolean
  max_reference_materials?: number
  max_reference_images?: number
  max_reference_images_with_video?: number
  max_reference_videos?: number
  max_reference_audios?: number
  image_input_required?: boolean
  reference_material_required?: boolean
  image_formats?: string[]
  image_max_size_mb?: number
  image_min_dimension?: number
  image_max_dimension?: number
  image_min_aspect_ratio?: number
  image_max_aspect_ratio?: number
  video_formats?: string[]
  video_max_size_mb?: number
  video_min_duration_sec?: number
  video_max_duration_sec?: number
  video_min_dimension?: number
  video_max_dimension?: number
  video_min_pixels?: number
  video_max_pixels?: number
  video_min_aspect_ratio?: number
  video_max_aspect_ratio?: number
  video_min_fps?: number
  video_max_fps?: number
  audio_formats?: string[]
  audio_max_size_mb?: number
  audio_min_duration_sec?: number
  audio_max_duration_sec?: number
  generation_modes?: VideoGenerationMode[]
}

export interface VideoGenerationConfig {
  resolution?: string
  ratio?: string
  duration?: number // 4-12 seconds
  generate_audio?: boolean // Only Seedance 1.5 pro
  draft?: boolean // Draft mode
  seed?: number // Random seed
  camera_fixed?: boolean // Fixed camera
  watermark?: boolean // Whether to include watermark
  max_reference_images?: number // Legacy image-only reference limit
  capabilities?: VideoCapabilities // Model-declared capabilities
}

export interface ImageCapabilities {
  supports_image_input?: boolean
  max_reference_images?: number
  image_formats?: string[]
  image_max_size_mb?: number
  image_min_dimension?: number
  image_max_dimension?: number
  image_min_aspect_ratio?: number
  image_max_aspect_ratio?: number
}

// Image generation specific configuration
export interface ImageGenerationConfig {
  size?: string // '2K', '3K', '2048x2048', etc.
  capabilities?: ImageCapabilities
  sequential_image_generation?: 'auto' | 'disabled'
  max_images?: number
  response_format?: 'url' | 'b64_json'
  output_format?: 'jpeg' | 'png' | 'webp'
  output_compression?: number
  quality?: 'low' | 'medium' | 'high' | 'auto'
  background?: 'opaque' | 'transparent' | 'auto'
  moderation?: 'auto' | 'low'
  watermark?: boolean
  optimize_prompt_mode?: 'standard' | 'fast'
  max_reference_images?: number // Maximum number of reference images that can be uploaded
}

// Model CRD Types
export interface ModelCRD {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace: string
    displayName?: string // Human-readable display name
  }
  spec: {
    modelConfig: {
      env: {
        model: string // 'openai' | 'claude'
        model_id: string
        api_key: string
        base_url?: string
        custom_headers?: Record<string, string> // Custom HTTP headers to override defaults
        thinking_config?: Record<string, unknown> // Provider-native thinking/reasoning config
        thinkingConfig?: Record<string, unknown> // Legacy camelCase alias
      }
      context_window?: number // Maximum context window size in tokens
      max_output_tokens?: number // Maximum output tokens the model can generate per response
      visionSidecarModel?: VisionSidecarModelRef
    }
    protocol?: string
    apiFormat?: string
    isCustomConfig?: boolean
    isWeworkAvailable?: boolean
    costIndex?: string // Relative usage cost compared with the baseline model
    // New fields for multi-type model support
    modelType?: ModelCategoryType
    modelGroup?: string
    modelSubGroup?: string
    ttsConfig?: TTSConfig
    sttConfig?: STTConfig
    embeddingConfig?: EmbeddingConfig
    rerankConfig?: RerankConfig
    modelCapabilities?: ModelCapabilities
    videoConfig?: VideoGenerationConfig
    imageConfig?: ImageGenerationConfig
  }
  status?: {
    state: string
  }
}

export interface ModelListResponse {
  items: ModelCRD[]
  total?: number
}

// Public Model Types
export interface PublicModelItem {
  id: number
  name: string
  config: {
    env?: {
      model?: string
      model_id?: string
      api_key?: string
      base_url?: string
      custom_headers?: Record<string, string> // Custom HTTP headers to override defaults
    }
  }
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface PublicModelListResponse {
  total: number
  items: PublicModelItem[]
}

// Legacy Model Types (for backward compatibility)
export interface Model {
  name: string
  displayName?: string | null
}

export interface ModelNamesResponse {
  data: Model[]
}

// Unified Model Types (new API with type differentiation)
export type ModelTypeEnum = 'public' | 'user' | 'group' | 'runtime'

export interface UnifiedModel {
  name: string
  type: ModelTypeEnum // identifies model source
  displayName?: string | null
  provider?: string | null // 'openai' | 'claude'
  modelId?: string | null
  runtime?: {
    family?: string | null
    provider?: string | null
  } | null
  namespace?: string // Resource namespace (group name or 'default')
  resourceUserId?: number
  config?: Record<string, unknown>
  isActive?: boolean
  modelCategoryType?: ModelCategoryType // New: model category type (llm, tts, stt, embedding, rerank)
  isAdvanced?: boolean
  modelGroup?: string | null
  modelSubGroup?: string | null
  contextWindow?: number | null
  maxOutputTokens?: number | null
  costIndex?: string | null
  modelCapabilities?: ModelCapabilities | null
  created_at?: string | null
  updated_at?: string | null
  isReference?: boolean
  listingId?: number | null
}

export interface UnifiedModelListResponse {
  data: UnifiedModel[]
}

export interface ErrorRecommendationEntry {
  description: string
  models: UnifiedModel[]
}

export type ErrorRecommendationsResponse = {
  data: Record<string, ErrorRecommendationEntry>
}

// Test Connection Types
export interface TestConnectionRequest {
  provider_type:
    | 'openai'
    | 'anthropic'
    | 'gemini'
    | 'gemini-deep-research'
    | 'openai-responses'
    | 'gpt-image'
    | 'custom'
  model_id: string
  api_key: string
  base_url?: string
  custom_headers?: Record<string, string> // Custom HTTP headers to override defaults
  model_category_type?: ModelCategoryType // Model category type for appropriate test method
}

export interface TestConnectionResponse {
  success: boolean
  message: string
}

// Fetch Available Models Types
export interface FetchAvailableModelsRequest {
  provider_type: 'openai' | 'anthropic' | 'gemini' | 'custom'
  api_key: string
  base_url?: string
  custom_headers?: Record<string, string>
}

export interface AvailableModel {
  id: string
  name?: string
  created?: number
  owned_by?: string
}

export interface FetchAvailableModelsResponse {
  success: boolean
  models: AvailableModel[]
  message?: string
}

// Compatible Models Types
export interface CompatibleModel {
  name: string
}

export interface CompatibleModelsResponse {
  models: CompatibleModel[]
}

// Model Services
// Model Services
export const modelApis = {
  /**
   * Get model names for a specific shell type (legacy API, use getUnifiedModels for new implementations)
   */
  async getModelNames(shellType: string): Promise<ModelNamesResponse> {
    return apiClient.get(`/models/names?shell_type=${encodeURIComponent(shellType)}`)
  },

  /**
   * Get unified list of all available models (both public and user-defined)
   *
   * This is the recommended API for new implementations.
   * Each model includes a 'type' field ('public' or 'user') to identify its source.
   *
   * @param shellType - Optional shell type to filter compatible models
   * @param includeConfig - Whether to include full model config in response
   * @param scope - Resource scope: 'personal', 'group', or 'all'
   * @param groupName - Optional group name. When omitted with group scope, all accessible groups are returned.
   * @param modelCategoryType - Optional model category type filter (llm, tts, stt, embedding, rerank)
   */
  async getUnifiedModels(
    shellType?: string,
    includeConfig: boolean = false,
    scope?: 'personal' | 'group' | 'all',
    groupName?: string,
    modelCategoryType?: ModelCategoryType
  ): Promise<UnifiedModelListResponse> {
    const params = new URLSearchParams()
    if (shellType) {
      params.append('shell_type', shellType)
    }
    if (includeConfig) {
      params.append('include_config', 'true')
    }
    if (scope) {
      params.append('scope', scope)
    }
    if (groupName) {
      params.append('group_name', groupName)
    }
    if (modelCategoryType) {
      params.append('model_category_type', modelCategoryType)
    }
    const queryString = params.toString()
    return apiClient.get(`/models/unified${queryString ? `?${queryString}` : ''}`)
  },

  /**
   * Get a specific model by name and optional type
   *
   * @param modelName - Model name
   * @param modelType - Optional model type ('public' or 'user')
   */
  async getUnifiedModel(modelName: string, modelType?: ModelTypeEnum): Promise<UnifiedModel> {
    const params = new URLSearchParams()
    if (modelType) {
      params.append('model_type', modelType)
    }
    const queryString = params.toString()
    return apiClient.get(
      `/models/unified/${encodeURIComponent(modelName)}${queryString ? `?${queryString}` : ''}`
    )
  },
  /**
   * Get all models as CRD resources (user's own models)
   * @param scope - Resource scope: 'personal', 'group', or 'all'
   * @param groupName - Optional group name. Also used as namespace when creating in group scope.
   */
  async getAllModels(
    scope?: 'personal' | 'group' | 'all',
    groupName?: string
  ): Promise<ModelListResponse> {
    const params = new URLSearchParams()
    if (scope) {
      params.append('scope', scope)
    }
    if (groupName) {
      params.append('group_name', groupName)
    }
    const queryString = params.toString()
    // Use groupName as namespace when provided, otherwise use 'default'
    const namespace = groupName || 'default'
    return apiClient.get(
      `/v1/namespaces/${encodeURIComponent(namespace)}/models${queryString ? `?${queryString}` : ''}`
    )
  },

  /**
   * Get all public models
   */
  async getPublicModels(page: number = 1, limit: number = 100): Promise<PublicModelListResponse> {
    return apiClient.get(`/models?page=${page}&limit=${limit}`)
  },

  /**
   * Get a single model by name
   * @param name - Model name
   * @param namespace - Namespace (default: 'default')
   */
  async getModel(name: string, namespace: string = 'default'): Promise<ModelCRD> {
    return apiClient.get(
      `/v1/namespaces/${encodeURIComponent(namespace)}/models/${encodeURIComponent(name)}`
    )
  },

  /**
   * Create a new model
   * @param model - Model CRD data (namespace is taken from model.metadata.namespace)
   */
  async createModel(model: ModelCRD): Promise<ModelCRD> {
    const namespace = model.metadata.namespace || 'default'
    return apiClient.post(`/v1/namespaces/${encodeURIComponent(namespace)}/models`, model)
  },

  /**
   * Update an existing model
   * @param name - Model name
   * @param model - Model CRD data (namespace is taken from model.metadata.namespace)
   */
  async updateModel(name: string, model: ModelCRD): Promise<ModelCRD> {
    const namespace = model.metadata.namespace || 'default'
    return apiClient.put(
      `/v1/namespaces/${encodeURIComponent(namespace)}/models/${encodeURIComponent(name)}`,
      model
    )
  },

  /**
   * Delete a model
   * @param name - Model name
   * @param namespace - Namespace (default: 'default')
   */
  async deleteModel(name: string, namespace: string = 'default'): Promise<void> {
    return apiClient.delete(
      `/v1/namespaces/${encodeURIComponent(namespace)}/models/${encodeURIComponent(name)}`
    )
  },

  /**
   * Test model connection
   */
  async testConnection(config: TestConnectionRequest): Promise<TestConnectionResponse> {
    return apiClient.post('/models/test-connection', config)
  },

  /**
   * Fetch available models from API provider
   */
  async fetchAvailableModels(
    config: FetchAvailableModelsRequest
  ): Promise<FetchAvailableModelsResponse> {
    return apiClient.post('/models/fetch-available-models', config)
  },

  /**
   * Get models compatible with a specific shell type
   */
  async getCompatibleModels(shellType: string): Promise<CompatibleModelsResponse> {
    return apiClient.get(`/models/compatible?shell_type=${encodeURIComponent(shellType)}`)
  },

  /**
   * Get model recommendations for specific error types
   */
  async getErrorRecommendations(): Promise<ErrorRecommendationsResponse> {
    return apiClient.get('/models/error-recommendations')
  },
}
