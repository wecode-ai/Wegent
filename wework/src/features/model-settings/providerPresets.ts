import type {
  ModelProvider,
  ProviderModel,
} from '../../../electron/src/host/model-configuration-contract'
import {
  findConfiguredLocalModelProviderProfile,
  findLocalModelProviderProfile,
} from './localModelProviders'
import { createDefaultLocalModelCatalogEntry } from './localModelCatalog'

/** Recognize saved presets only when their endpoint and protocol still match. */
export function detectProviderPreset(provider: ModelProvider): string {
  return findConfiguredLocalModelProviderProfile(provider)?.id ?? 'custom'
}

/** Apply the existing runtime profile defaults when selecting a new model. */
export function createPresetProviderModel(
  presetId: string,
  modelId: string,
  options: { createId?: () => string; apiFormat?: ModelProvider['api_format'] } = {}
): ProviderModel {
  const profile = findLocalModelProviderProfile(presetId)
  const apiFormat = options.apiFormat ?? profile.apiFormat
  const toolProfile =
    profile.toolProfile === 'custom' && apiFormat !== 'openai-responses'
      ? 'function'
      : profile.toolProfile
  const contextWindow = profile.modelDefaults?.[modelId]?.contextWindow ?? profile.contextWindow
  const modalities = profile.modelDefaults?.[modelId]?.inputModalities
  const model: ProviderModel = {
    id: (options.createId ?? (() => crypto.randomUUID()))(),
    model_id: modelId,
    provider_profile_id: profile.id,
    tool_profile: toolProfile,
    context_window: contextWindow,
    web_search_mode: profile.webSearchMode,
    image_generation_enabled: profile.imageGenerationEnabled,
  }
  if (modalities)
    model.catalog_entry = {
      ...createDefaultLocalModelCatalogEntry({
        id: model.id,
        displayName: modelId,
        toolProfile,
        contextWindow,
      }),
      input_modalities: [...modalities],
    }
  return model
}
