import type { ModelOptions, ModelType } from './models'
import {
  codexOfficialModelIdFromModelName,
  CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME,
  CODEX_RUNTIME_MODEL_ID,
} from './codex-official-models'

const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const RESPONSES_API_FORMAT = 'responses'
export const DEFAULT_CODEX_CATALOG_MODEL_ID = 'wework-gpt-6.1-sol'

export const CLOUD_MODEL_NAMESPACE_OPTION = 'weworkCloudModelNamespace'
export const CLOUD_MODEL_RESOURCE_USER_ID_OPTION = 'weworkCloudModelResourceUserId'
export const CLOUD_MODEL_CONTEXT_WINDOW_OPTION = 'weworkCloudModelContextWindow'
export const CLOUD_MODEL_MAX_OUTPUT_TOKENS_OPTION = 'weworkCloudModelMaxOutputTokens'
export const CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION = 'weworkCloudModelUpstreamApiFormat'
export const CLOUD_MODEL_CODEX_CATALOG_MODEL_ID_OPTION = 'weworkCloudModelCodexCatalogModelId'
export const CLOUD_MODEL_VISION_SIDECAR_OPTION = 'weworkCloudVisionSidecar'
export const CLOUD_MODEL_NATIVE_TOOL_SEARCH_OPTION = 'weworkCloudModelNativeToolSearch'
export const CLOUD_MODEL_NATIVE_NAMESPACE_TOOLS_OPTION = 'weworkCloudModelNativeNamespaceTools'
export const CLOUD_MODEL_CODEX_REQUEST_MODE_OPTION = 'weworkCloudModelCodexRequestMode'

export interface CloudVisionSidecarReference {
  modelName: string
  modelType: ModelType
  namespace: string
  resourceUserId: number
  apiFormat: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages'
}

/**
 * Validate the shape of a cloud vision sidecar reference stored on a Model CRD.
 *
 * The reference is authoritative: the backend LLM gateway resolves it against the
 * `kinds` table and enforces access with the same identity headers, so there is no
 * client-side catalog lookup here. A reference that points at a missing or
 * non-visual model fails per image inside the executor's vision sidecar with an
 * inline diagnostic, instead of leaking the image to a text-only primary model.
 */
export function parseCloudVisionSidecarReference(
  value: unknown
): CloudVisionSidecarReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.modelName !== 'string' ||
    !record.modelName.trim() ||
    !['public', 'user', 'group'].includes(String(record.modelType)) ||
    typeof record.namespace !== 'string' ||
    !record.namespace.trim() ||
    typeof record.resourceUserId !== 'number' ||
    !Number.isInteger(record.resourceUserId) ||
    record.resourceUserId < 0 ||
    !['openai-responses', 'openai-chat-completions', 'anthropic-messages'].includes(
      String(record.apiFormat)
    )
  ) {
    return null
  }
  return {
    modelName: record.modelName.trim(),
    modelType: record.modelType as ModelType,
    namespace: record.namespace.trim(),
    resourceUserId: record.resourceUserId,
    apiFormat: record.apiFormat as CloudVisionSidecarReference['apiFormat'],
  }
}

export function normalizeModelOptionValue(optionId: string, value?: string): string | undefined {
  if (!value) return value
  if (optionId !== 'reasoning') return value

  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_')
  if (['extra_high', 'x_high', 'x-high'].includes(normalized)) {
    return 'xhigh'
  }
  if (normalized === 'maximum') return 'max'
  return value
}

export function normalizeModelOptionAliases(options: ModelOptions = {}): ModelOptions {
  return Object.fromEntries(
    Object.entries(options).map(([optionId, value]) => [
      optionId,
      normalizeModelOptionValue(optionId, value) ?? value,
    ])
  )
}

export interface CloudModelGateway {
  baseUrl: string
  apiKey: string
  backendUrl?: string
}

export function isCloudModelType(
  modelType?: string | null
): modelType is 'public' | 'user' | 'group' {
  return modelType === 'public' || modelType === 'user' || modelType === 'group'
}

function builtInCodexModelId(modelId?: string): string {
  if (modelId === CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME) {
    throw new Error('Codex model list is unavailable')
  }
  return codexOfficialModelIdFromModelName(modelId) ?? modelId ?? CODEX_RUNTIME_MODEL_ID
}

export function runtimeReasoningConfig(
  modelOptions?: Record<string, string>
): Record<string, string> | null {
  const reasoning = normalizeModelOptionValue('reasoning', modelOptions?.reasoning)
  const summary = modelOptions?.summary
  const result: Record<string, string> = {}
  if (reasoning) result.effort = reasoning
  if (summary) result.summary = summary
  return Object.keys(result).length > 0 ? result : null
}

function cloudVisionSidecarConfig(
  runtime: string,
  modelOptions: Record<string, string> | undefined,
  cloudModelGateway: CloudModelGateway
): Record<string, unknown> | null {
  const raw = modelOptions?.[CLOUD_MODEL_VISION_SIDECAR_OPTION]
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('Cloud vision sidecar reference is invalid', {
      cause: error,
    })
  }
  const sidecar = parseCloudVisionSidecarReference(parsed)
  if (!sidecar) {
    throw new Error('Cloud vision sidecar reference is invalid')
  }

  return {
    enabled: true,
    // The backend LLM gateway exposes a single protocol-agnostic route and picks the
    // upstream endpoint from the referenced Model CRD, so every api_format posts here.
    request_url: `${cloudModelGateway.baseUrl.replace(/\/+$/, '')}/responses`,
    api_format: sidecar.apiFormat,
    api_key: cloudModelGateway.apiKey,
    model_id: sidecar.modelName,
    default_headers: {
      'X-Wegent-Model-Type': sidecar.modelType,
      'X-Wegent-Model-Namespace': sidecar.namespace,
      'X-Wegent-Model-User-Id': String(sidecar.resourceUserId),
      'X-Wegent-Upstream-Header-wecode-executor': wecodeExecutorForRuntime(runtime),
      'X-Wegent-Upstream-Header-wecode-source': 'wegent-local',
    },
    max_descriptions_per_turn: 8,
    timeout_ms: 45_000,
  }
}

function wecodeExecutorForRuntime(runtime: string): string {
  const normalized = runtime
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  return normalized === 'claude' || normalized === 'claudecode' ? 'claudecode' : normalized
}

export interface LocalRuntimeModelConfigInput {
  runtime: string
  modelName?: string
  modelType?: string | null
  modelOptions?: Record<string, string>
  cloudModelGateway?: CloudModelGateway
}

export function resolveLocalRuntimeModelConfig({
  runtime,
  modelName,
  modelType,
  modelOptions,
  cloudModelGateway,
}: LocalRuntimeModelConfigInput): Record<string, unknown> {
  if (modelOptions?.runnerModelProvider)
    return {
      model_id: modelName,
      model_provider: modelOptions.runnerModelProvider,
    }
  if (isCloudModelType(modelType)) {
    if (!modelName || !cloudModelGateway) {
      throw new Error('Cloud model gateway is not configured')
    }
    const namespace = modelOptions?.[CLOUD_MODEL_NAMESPACE_OPTION]
    const resourceUserId = modelOptions?.[CLOUD_MODEL_RESOURCE_USER_ID_OPTION]
    if (!namespace || !resourceUserId || !/^\d+$/.test(resourceUserId)) {
      throw new Error('Cloud model identity is incomplete')
    }
    const contextWindow = Number(modelOptions?.[CLOUD_MODEL_CONTEXT_WINDOW_OPTION])
    const maxOutputTokens = Number(modelOptions?.[CLOUD_MODEL_MAX_OUTPUT_TOKENS_OPTION])
    const upstreamApiFormat =
      modelOptions?.[CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION] ?? 'openai-responses'
    const gatewayConfig = {
      model: 'openai',
      model_id: modelName,
      wework_model_kind: 'cloud',
      api_format: RESPONSES_API_FORMAT,
      protocol: OPENAI_RESPONSES_PROTOCOL,
      upstream_api_format: upstreamApiFormat,
      base_url: cloudModelGateway.baseUrl,
      api_key: cloudModelGateway.apiKey,
      default_headers: {
        'X-Wegent-Model-Type': modelType,
        'X-Wegent-Model-Namespace': namespace,
        'X-Wegent-Model-User-Id': resourceUserId,
        'X-Wegent-Upstream-Header-wecode-executor': wecodeExecutorForRuntime(runtime),
        'X-Wegent-Upstream-Header-wecode-source': 'wegent-local',
      },
      ...(Number.isFinite(contextWindow) && contextWindow > 0
        ? { model_context_window: contextWindow }
        : {}),
      ...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? { max_output_tokens: maxOutputTokens }
        : {}),
    }
    if (runtime === 'claude_code') return gatewayConfig
    const codexRequestMode = modelOptions?.[CLOUD_MODEL_CODEX_REQUEST_MODE_OPTION] ?? 'auto'
    if (
      !['auto', 'standard', 'passthrough'].includes(codexRequestMode) ||
      (codexRequestMode === 'passthrough' && upstreamApiFormat !== 'openai-responses')
    ) {
      throw new Error('Invalid Codex request mode for the selected model protocol')
    }
    const nativeToolSearch =
      modelOptions?.[CLOUD_MODEL_NATIVE_TOOL_SEARCH_OPTION] == null
        ? false
        : modelOptions[CLOUD_MODEL_NATIVE_TOOL_SEARCH_OPTION]?.trim().toLowerCase() === 'true'
    const nativeNamespaceTools =
      modelOptions?.[CLOUD_MODEL_NATIVE_NAMESPACE_TOOLS_OPTION] == null
        ? false
        : modelOptions[CLOUD_MODEL_NATIVE_NAMESPACE_TOOLS_OPTION]?.trim().toLowerCase() === 'true'
    const visionSidecar = cloudVisionSidecarConfig(runtime, modelOptions, cloudModelGateway)
    const primaryCodexCatalogModelId =
      modelOptions?.[CLOUD_MODEL_CODEX_CATALOG_MODEL_ID_OPTION] || DEFAULT_CODEX_CATALOG_MODEL_ID
    return {
      ...gatewayConfig,
      codex_catalog_model_id: primaryCodexCatalogModelId,
      codex_request_mode: codexRequestMode,
      native_tool_search: nativeToolSearch,
      native_namespace_tools: nativeNamespaceTools,
      tool_profile: 'function',
      ...(visionSidecar ? { vision_sidecar: visionSidecar } : {}),
      codex_responses_compat_proxy: true,
      runtime_config: {
        codex: {
          use_user_config: false,
          configured: true,
        },
      },
    }
  }

  const codexProviderId = modelOptions?.codexProviderId || modelOptions?.codex_model_provider
  const codexProviderName = modelOptions?.codexProviderName || modelOptions?.codex_provider_name
  const codexProviderType = modelOptions?.codexProviderType || modelOptions?.codex_provider_type
  return {
    model: 'openai',
    model_id: builtInCodexModelId(modelName),
    wework_model_kind: codexProviderType === 'provider' ? 'codex-provider' : 'codex-official',
    api_format: RESPONSES_API_FORMAT,
    protocol: OPENAI_RESPONSES_PROTOCOL,
    ...(codexProviderId ? { model_provider: codexProviderId } : {}),
    ...(codexProviderName ? { provider_name: codexProviderName } : {}),
    runtime_config: {
      codex: {
        use_user_config: true,
        configured: true,
      },
    },
  }
}

export function applyRuntimeModelOptionValues(
  modelConfig: Record<string, unknown>,
  modelOptions?: Record<string, string>
): Record<string, unknown> {
  const reasoning = runtimeReasoningConfig(modelOptions)
  const serviceTier = modelOptions?.speed || modelOptions?.service_tier
  return {
    ...modelConfig,
    ...(reasoning ? { reasoning } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  }
}
