/** Dependency-free IPC contract shared by the renderer and native model configuration service. */
export const MODEL_API_FORMATS = [
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
] as const
export type ModelApiFormat = (typeof MODEL_API_FORMATS)[number]

export interface ProviderModel {
  id: string
  model_id: string
  display_name?: string
  enabled?: boolean
  api_format?: ModelApiFormat
  request_path?: string
  context_window?: number
  tool_profile?: 'custom' | 'function' | 'shell'
  codex_tool_compatibility?: 'native' | 'standard'
  web_search_mode?: 'disabled' | 'cached' | 'live'
  image_generation_enabled?: boolean
  vision_model_config_id?: string
  provider_profile_id?: string
  codex_catalog_model_id?: string
  catalog_entry?: Record<string, unknown>
  group?: string
}

export interface ModelProvider {
  id: string
  name: string
  base_url: string
  api_format: ModelApiFormat
  request_path?: string
  models_path?: string
  api_key?: string
  api_key_ref?: string
  models_api_key_header?: 'Authorization' | 'X-Api-Key'
  enabled?: boolean
  models: ProviderModel[]
}

export type PublicModelProvider = Omit<ModelProvider, 'api_key'> & {
  api_key_configured: boolean
}
export interface ModelConfiguration {
  version: 1
  providers: ModelProvider[]
}
export interface ModelConfigurationSnapshot {
  path: string
  revision: string
  providers: PublicModelProvider[]
  loadedAt: string
  error?: string
}
export interface ResolvedProviderModel {
  provider: Omit<ModelProvider, 'models'>
  model: ProviderModel
}
