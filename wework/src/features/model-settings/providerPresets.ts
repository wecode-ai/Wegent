import type { ModelProvider, ProviderModel } from './providerModelConfiguration'
import { LOCAL_MODEL_PROVIDER_PROFILES, findLocalModelProviderProfile } from './localModelProviders'
import { createDefaultLocalModelCatalogEntry } from './localModelCatalog'

/** Recognize saved presets only when their endpoint and protocol still match. */
export function detectProviderPreset(provider: ModelProvider): string {
  return (
    LOCAL_MODEL_PROVIDER_PROFILES.find(
      profile =>
        profile.id !== 'custom' &&
        profile.baseUrl.replace(/\/+$/, '') === provider.base_url.replace(/\/+$/, '') &&
        profile.apiFormat === provider.api_format &&
        (!provider.request_path || profile.requestPath === provider.request_path) &&
        (!provider.models_path || profile.modelsPath === provider.models_path) &&
        (!provider.models_api_key_header ||
          (profile.modelsApiKeyHeader ?? 'Authorization') === provider.models_api_key_header)
    )?.id ?? 'custom'
  )
}

/** Apply the existing runtime profile defaults when selecting a new model. */
export function createPresetProviderModel(presetId: string, modelId: string): ProviderModel {
  const profile = findLocalModelProviderProfile(presetId)
  const contextWindow = profile.modelDefaults?.[modelId]?.contextWindow ?? profile.contextWindow
  const modalities = profile.modelDefaults?.[modelId]?.inputModalities
  const model: ProviderModel = {
    id: crypto.randomUUID(),
    model_id: modelId,
    provider_profile_id: profile.id,
    tool_profile: profile.toolProfile,
    context_window: contextWindow,
    web_search_mode: profile.webSearchMode,
    image_generation_enabled: profile.imageGenerationEnabled,
  }
  if (modalities)
    model.catalog_entry = {
      ...createDefaultLocalModelCatalogEntry({
        id: model.id,
        displayName: modelId,
        toolProfile: profile.toolProfile,
        contextWindow,
      }),
      input_modalities: [...modalities],
    }
  return model
}
