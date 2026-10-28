import { randomUUID } from 'node:crypto'
import { normalizeLegacyModelProfile } from './legacy-model-profile.js'
import {
  validateModelConfiguration,
  type ModelProvider,
  type ProviderModel,
} from './model-configuration-schema.js'

/** Strictly convert the historical renderer format without exposing its keys to a renderer. */
export function legacyModelProviders(source: string): ModelProvider[] {
  const input: unknown = JSON.parse(source)
  if (!Array.isArray(input)) throw new Error('Legacy model settings must be an array')
  const providers: ModelProvider[] = []
  const groups = new Map<string, ModelProvider>()
  const fieldNames: Record<string, keyof ProviderModel> = {
    id: 'id',
    modelId: 'model_id',
    displayName: 'display_name',
    enabled: 'enabled',
    contextWindow: 'context_window',
    maxOutputTokens: 'max_output_tokens',
    toolProfile: 'tool_profile',
    codexToolCompatibility: 'codex_tool_compatibility',
    webSearchMode: 'web_search_mode',
    imageGenerationEnabled: 'image_generation_enabled',
    visionModelConfigId: 'vision_model_config_id',
    providerProfileId: 'provider_profile_id',
    codexCatalogModelId: 'codex_catalog_model_id',
    catalogEntry: 'catalog_entry',
    group: 'group',
  }
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid legacy model settings')
    const old = normalizeLegacyModelProfile(value as Record<string, unknown>)
    const format = old.apiFormat ?? 'openai-responses'
    const requestPath =
      old.requestPath ??
      (format === 'anthropic-messages'
        ? '/v1/messages'
        : format === 'openai-chat-completions'
          ? '/chat/completions'
          : '/responses')
    if (typeof old.baseUrl !== 'string' || typeof requestPath !== 'string')
      throw new Error('Invalid legacy model endpoint')
    let base = old.baseUrl.trim().replace(/\/+$/, '')
    let path = requestPath.trim().replace(/\/+$/, '')
    if (!path.startsWith('/')) path = `/${path}`
    if (old.requestUrlMode === 'custom_url') {
      if (base.toLowerCase().endsWith(path.toLowerCase())) base = base.slice(0, -path.length)
      else {
        const url = new URL(base)
        const segments = url.pathname.split('/').filter(Boolean)
        if (segments.length >= 2 && segments.at(-1)?.toLowerCase() !== 'v1') {
          path = `/${segments.pop()}${url.search}${url.hash}`
          base = `${url.origin}/${segments.join('/')}`
        }
      }
    }
    const model: Record<string, unknown> = {}
    for (const [from, to] of Object.entries(fieldNames))
      if (old[from] !== undefined) model[to] = old[from]
    const candidate = {
      id: `migrated-${randomUUID()}`,
      name: old.group || new URL(base).hostname,
      base_url: base,
      api_format: format,
      request_path: path,
      ...(old.apiKey ? { api_key: old.apiKey } : {}),
      models: [model],
    }
    const validated = validateModelConfiguration({ version: 1, providers: [candidate] })
      .providers[0]
    const identity = JSON.stringify([
      validated.base_url,
      validated.api_format,
      validated.request_path,
      validated.api_key,
    ])
    const shared = groups.get(identity)
    if (shared) shared.models.push(...validated.models)
    else {
      groups.set(identity, validated)
      providers.push(validated)
    }
  }
  return validateModelConfiguration({ version: 1, providers }).providers
}
