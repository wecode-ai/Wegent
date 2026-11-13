import type { ProviderModel, ResolvedProviderModel } from './model-configuration-contract.js'

const MODEL_RUNTIME_METHODS = new Set([
  'runtime.tasks.create',
  'runtime.tasks.send',
  'runtime.tasks.rollback',
  'runtime.tasks.interrupt_and_send',
  'runtime.tasks.fork_at_turn',
  'runtime.tasks.compact',
  'runtime.tasks.supervisor.set',
  'runtime.models.sync_creation_profiles',
  'runtime.automations.create',
  'runtime.automations.update',
  'runtime.text.generate',
  'runtime.text.predict_reply',
  'runtime.harness_proxy.register',
  'runtime.collaboration.dispatch',
  'executions.enqueue',
])

/** Only execution/configuration commands need to materialize a saved model reference. */
export function isNativeModelRuntimeMethod(method: string): boolean {
  return MODEL_RUNTIME_METHODS.has(method)
}

/** Default configured APIs to portable tools; native tools require an explicit selection. */
export function modelInterfaceToolProfile(config: {
  apiFormat: string
  providerProfileId?: string
  toolProfile?: string | null
}): NonNullable<ProviderModel['tool_profile']> {
  const value = config.toolProfile
  return value === 'custom' || value === 'function' || value === 'shell' ? value : 'function'
}

/** Normalized settings shared by ordinary tasks and device-owned runner models. */
export interface ModelInterfaceRuntimeInput {
  id: string
  modelId: string
  displayName: string
  baseUrl: string
  apiFormat: string
  requestPath?: string
  requestUrl?: string
  apiKey?: string
  toolProfile?: string
  providerProfileId?: string
  codexToolCompatibility?: string
  codexCatalogModelId?: string
  contextWindow?: number
  maxOutputTokens?: number
  webSearchMode?: string
  imageGenerationEnabled?: boolean
}

export function modelInterfaceProviderId(id: string): string {
  return `local-${id}`.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'local'
}

/** Resolve the same protocol and tool settings for foreground and background work. */
export function modelInterfaceRuntimeConfig(
  config: ModelInterfaceRuntimeInput,
  visionSidecar: Record<string, unknown> | null = null,
  reasoningEffort: string | null = null
): Record<string, unknown> {
  const nativeTools =
    config.apiFormat === 'openai-responses' && config.codexToolCompatibility === 'native'
  const requestPath =
    config.requestPath ??
    (config.apiFormat === 'anthropic-messages'
      ? config.baseUrl.endsWith('/v1')
        ? '/messages'
        : '/v1/messages'
      : config.apiFormat === 'openai-chat-completions'
        ? '/chat/completions'
        : '/responses')
  return {
    model: 'openai',
    model_id: config.modelId,
    wework_model_kind: 'model-interface',
    wework_local_model_id: `local-model:${config.id}`,
    codex_catalog_model_id: config.codexCatalogModelId || 'wework-gpt-6.1-sol',
    api_format: 'responses',
    upstream_api_format: config.apiFormat,
    native_tool_search: nativeTools,
    native_namespace_tools: nativeTools,
    tool_profile: modelInterfaceToolProfile(config),
    protocol: 'openai-responses',
    base_url: config.baseUrl,
    responses_url: config.requestUrl ?? `${config.baseUrl.replace(/\/+$/, '')}${requestPath}`,
    api_key: config.apiKey || 'dummy',
    model_provider: modelInterfaceProviderId(config.id),
    provider_name: config.displayName,
    display_name: config.displayName,
    ...(config.contextWindow ? { model_context_window: config.contextWindow } : {}),
    ...(config.maxOutputTokens ? { max_output_tokens: config.maxOutputTokens } : {}),
    web_search: config.webSearchMode ?? 'disabled',
    image_generation: config.imageGenerationEnabled === true,
    ...(visionSidecar ? { vision_sidecar: visionSidecar } : {}),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    codex_responses_compat_proxy: true,
    runtime_config: { codex: { use_user_config: false, configured: false } },
  }
}

/** Keep secrets in the native runtime projection, never in public runner identities. */
export function modelInterfaceRunnerModels(entries: ResolvedProviderModel[]) {
  const enabled = entries.filter(
    ({ model, provider }) => model.enabled !== false && provider.enabled !== false
  )
  const normalize = ({ model, provider }: ResolvedProviderModel): ModelInterfaceRuntimeInput => ({
    id: model.id,
    modelId: model.model_id,
    displayName: model.display_name || model.model_id,
    baseUrl: provider.base_url,
    apiFormat: model.api_format ?? provider.api_format,
    requestPath:
      model.request_path ??
      (model.api_format && model.api_format !== provider.api_format
        ? undefined
        : provider.request_path),
    apiKey: provider.api_key,
    toolProfile: model.tool_profile,
    providerProfileId: model.provider_profile_id,
    codexToolCompatibility: model.codex_tool_compatibility,
    codexCatalogModelId:
      model.codex_catalog_model_id ??
      (typeof model.catalog_entry?.slug === 'string'
        ? model.catalog_entry.slug
        : `wework-custom-${model.id}`),
    contextWindow: model.context_window,
    maxOutputTokens: model.max_output_tokens,
    webSearchMode: model.web_search_mode,
    imageGenerationEnabled: model.image_generation_enabled,
  })
  return enabled.flatMap(entry => {
    const config = normalize(entry)
    const vision = entry.model.vision_model_config_id
      ? enabled.find(row => row.model.id === entry.model.vision_model_config_id)
      : undefined
    if (entry.model.vision_model_config_id && !vision) return []
    const visionConfig = vision ? normalize(vision) : null
    const sidecar = visionConfig
      ? {
          enabled: true,
          request_url: modelInterfaceRuntimeConfig(visionConfig).responses_url,
          api_format: visionConfig.apiFormat,
          api_key: visionConfig.apiKey || 'dummy',
          model_id: visionConfig.modelId,
          max_descriptions_per_turn: 8,
          timeout_ms: 45000,
        }
      : null
    const reasoning = entry.model.catalog_entry?.default_reasoning_level
    const runtimeConfig = modelInterfaceRuntimeConfig(
      config,
      sidecar,
      typeof reasoning === 'string' ? reasoning : null
    )
    if (
      entry.model.provider_profile_id &&
      entry.model.provider_profile_id !== 'custom' &&
      !entry.model.codex_catalog_model_id &&
      !entry.model.catalog_entry?.slug
    )
      runtimeConfig.codex_catalog_model_id = null
    return [
      {
        runtime: 'codex',
        provider: modelInterfaceProviderId(config.id),
        model_id: `local-model:${config.id}`,
        local_model_id: `local-model:${config.id}`,
        label: config.displayName,
        account_label: entry.provider.name,
        is_default: false,
        modelConfig: runtimeConfig,
      },
    ]
  })
}

/** A reference identifies configuration; it never carries authority to change its endpoint. */
export function hasNativeModelReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasNativeModelReference)
  const record = value as Record<string, unknown>
  return (
    record.wework_model_kind === 'model-interface' ||
    Object.values(record).some(hasNativeModelReference)
  )
}

/** The harness and task paths use the same native provider projection. */
export function modelHarnessUpstream(config: Record<string, unknown>): Record<string, unknown> {
  const headers = config.default_headers as Record<string, unknown> | undefined
  return {
    ...(config.wework_model_kind === 'model-interface'
      ? {
          wework_model_kind: config.wework_model_kind,
          wework_local_model_id: config.wework_local_model_id,
          model_provider: config.model_provider,
        }
      : {}),
    base_url: config.base_url,
    request_url: config.responses_url,
    api_format: config.upstream_api_format,
    convert_custom_tools: config.tool_profile !== 'custom',
    native_tool_search: config.native_tool_search === true,
    native_namespace_tools: config.native_namespace_tools === true,
    codex_request_mode: config.codex_request_mode ?? 'auto',
    api_key: config.api_key,
    default_headers: Object.entries(headers ?? {}).filter(([, value]) => typeof value === 'string'),
    proxy_url: (config.proxy as { url?: string } | undefined)?.url ?? null,
    model_id: config.model_id,
    routing_model_id: null,
    max_output_tokens: config.max_output_tokens ?? null,
  }
}
