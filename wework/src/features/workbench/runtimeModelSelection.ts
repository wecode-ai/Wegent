import {
  getCloudModelUpstreamApiFormat,
  resolveModelExecutionSelection,
  supportsCloudExecution,
} from '@/features/cloud-connection/modelExecution'
import { getDefaultModelOptions, normalizeModelOptionAliases } from '@/lib/model-ui'
import type {
  ModelOptions,
  ModelSelectionConfig,
  ModelType,
  RuntimeSendRequest,
  UnifiedModel,
} from '@/types/api'

export const CLOUD_MODEL_NAMESPACE_OPTION = 'weworkCloudModelNamespace'
export const CLOUD_MODEL_RESOURCE_USER_ID_OPTION = 'weworkCloudModelResourceUserId'
export const CLOUD_MODEL_CONTEXT_WINDOW_OPTION = 'weworkCloudModelContextWindow'
export const CLOUD_MODEL_MAX_OUTPUT_TOKENS_OPTION = 'weworkCloudModelMaxOutputTokens'
export const CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION = 'weworkCloudModelUpstreamApiFormat'
export const CLOUD_MODEL_CODEX_CATALOG_MODEL_ID_OPTION = 'weworkCloudModelCodexCatalogModelId'
export const CLOUD_MODEL_VISION_SIDECAR_OPTION = 'weworkCloudVisionSidecar'
export const CLOUD_MODEL_NATIVE_TOOL_SEARCH_OPTION = 'weworkCloudModelNativeToolSearch'
export const CLOUD_MODEL_NATIVE_NAMESPACE_TOOLS_OPTION = 'weworkCloudModelNativeNamespaceTools'

const KIMI_K3_CODEX_CATALOG_MODEL_ID = 'wework-kimi-k3'
const CLOUD_VISION_SIDECAR_CONFIG_KEY = 'visionSidecarModel'

interface CloudVisionSidecarReference {
  modelName: string
  modelType: ModelType
  namespace: string
  resourceUserId: number
  apiFormat: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages'
}

function parseCloudVisionSidecarReference(value: unknown): CloudVisionSidecarReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.modelName !== 'string' ||
    !['public', 'user', 'group'].includes(String(record.modelType)) ||
    typeof record.namespace !== 'string' ||
    typeof record.resourceUserId !== 'number' ||
    !Number.isInteger(record.resourceUserId) ||
    record.resourceUserId < 0 ||
    !['openai-responses', 'openai-chat-completions', 'anthropic-messages'].includes(
      String(record.apiFormat)
    )
  ) {
    return null
  }
  return record as unknown as CloudVisionSidecarReference
}

function getStringConfigValue(
  config: Record<string, unknown> | null | undefined,
  key: string
): string {
  const value = config?.[key]
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function getRawStringConfigValue(
  config: Record<string, unknown> | null | undefined,
  key: string
): string {
  const value = config?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function getBooleanConfigValue(
  config: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  return config?.[key] === true
}

function configuredBooleanValue(
  config: Record<string, unknown> | null | undefined,
  snakeCaseKey: string,
  camelCaseKey: string
): boolean | null {
  const value = config?.[snakeCaseKey] ?? config?.[camelCaseKey]
  return typeof value === 'boolean' ? value : null
}

function isNativeOpenAIResponsesModel(model: UnifiedModel, upstreamApiFormat: string): boolean {
  if (upstreamApiFormat !== 'openai-responses') return false

  const candidates = [
    model.modelId,
    model.name,
    getRawStringConfigValue(model.config, 'model_id'),
    getRawStringConfigValue(model.config, 'modelId'),
    getRawStringConfigValue(model.config, 'model'),
  ]
  return candidates.some(candidate => {
    const match = candidate
      ?.trim()
      .toLowerCase()
      .match(/^gpt-(\d+)\.(\d+)(?:-|$)/)
    if (!match) return false
    const major = Number(match[1])
    const minor = Number(match[2])
    return major > 5 || (major === 5 && minor >= 4)
  })
}

function cloudNativeToolCapabilities(
  model: UnifiedModel,
  upstreamApiFormat: string
): { nativeToolSearch: boolean; nativeNamespaceTools: boolean } {
  const inferred = isNativeOpenAIResponsesModel(model, upstreamApiFormat)
  return {
    nativeToolSearch:
      configuredBooleanValue(model.config, 'native_tool_search', 'nativeToolSearch') ?? inferred,
    nativeNamespaceTools:
      configuredBooleanValue(model.config, 'native_namespace_tools', 'nativeNamespaceTools') ??
      inferred,
  }
}

function modelKind(model: UnifiedModel): string {
  return (
    getStringConfigValue(model.config, 'weworkModelKind') ||
    getStringConfigValue(model.config?.ui as Record<string, unknown> | null, 'family')
  )
}

function cloudCodexCatalogModelId(model: UnifiedModel): string {
  const configured =
    getRawStringConfigValue(model.config, 'codex_catalog_model_id') ||
    getRawStringConfigValue(model.config, 'codexCatalogModelId')
  if (configured) return configured

  const candidates = [
    model.name,
    model.modelId,
    getRawStringConfigValue(model.config, 'model_id'),
    getRawStringConfigValue(model.config, 'modelId'),
    getRawStringConfigValue(model.config, 'model'),
  ]
  return candidates.some(value => value?.trim().toLowerCase().includes('kimi-k3'))
    ? KIMI_K3_CODEX_CATALOG_MODEL_ID
    : ''
}

function isLocalModel(model: UnifiedModel): boolean {
  return model.provider === 'local'
}

function isCloudModel(model: UnifiedModel): boolean {
  return model.provider !== 'local'
}

function selectionForModel(model: UnifiedModel): ModelSelectionConfig {
  return {
    modelName: model.name,
    modelType: model.type,
    options: getDefaultModelOptions(model),
  }
}

function isCodexCompatibleModel(model: UnifiedModel): boolean {
  return supportsCloudExecution(model)
}

export function resolveAutomaticModel(models: UnifiedModel[]): UnifiedModel | null {
  return models.find(model => !model.compatibilityDisabled) ?? null
}

export function defaultNewChatModelSelection(models: UnifiedModel[]): ModelSelectionConfig | null {
  const candidates = models.filter(model => !model.compatibilityDisabled)
  const selected =
    candidates.find(
      model =>
        isLocalModel(model) &&
        modelKind(model) === 'codex-official' &&
        getBooleanConfigValue(model.config, 'codexAuthConfigured')
    ) ??
    candidates.find(model => isLocalModel(model) && modelKind(model) === 'codex-provider') ??
    candidates.find(model => isLocalModel(model) && modelKind(model) === 'model-interface') ??
    candidates.find(isCloudModel) ??
    null
  return selected ? selectionForModel(selected) : null
}

export function inferRuntimeName(model: UnifiedModel | null): 'codex' | 'claude_code' {
  if (model && isCodexCompatibleModel(model)) return 'codex'
  return 'claude_code'
}

export function selectedModelExecutionFields(
  selectedModel: UnifiedModel | null,
  selectedModelOptions: ModelOptions
): Pick<RuntimeSendRequest, 'modelId' | 'modelType' | 'modelOptions'> {
  const normalizedSelectedModelOptions = normalizeModelOptionAliases(selectedModelOptions)
  const modelOptions: ModelOptions = {
    ...normalizedSelectedModelOptions,
    collaborationMode: normalizedSelectedModelOptions.collaborationMode ?? 'default',
  }
  if (!selectedModel) {
    return { modelOptions }
  }
  const codexProviderId = getRawStringConfigValue(selectedModel.config, 'codexProviderId')
  const codexProviderName = getRawStringConfigValue(selectedModel.config, 'codexProviderName')
  const codexProviderType = getRawStringConfigValue(selectedModel.config, 'codexProviderType')
  if (codexProviderId) modelOptions.codexProviderId = codexProviderId
  if (codexProviderName) modelOptions.codexProviderName = codexProviderName
  if (codexProviderType) modelOptions.codexProviderType = codexProviderType
  const executionModel = resolveModelExecutionSelection(selectedModel)
  if (
    executionModel.modelType === 'public' ||
    executionModel.modelType === 'user' ||
    executionModel.modelType === 'group'
  ) {
    if (executionModel.modelNamespace) {
      modelOptions[CLOUD_MODEL_NAMESPACE_OPTION] = executionModel.modelNamespace
    }
    if (typeof executionModel.resourceUserId === 'number') {
      modelOptions[CLOUD_MODEL_RESOURCE_USER_ID_OPTION] = String(executionModel.resourceUserId)
    }
    const upstreamApiFormat = getCloudModelUpstreamApiFormat(selectedModel)
    if (upstreamApiFormat) {
      modelOptions[CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION] = upstreamApiFormat
      const nativeCapabilities = cloudNativeToolCapabilities(selectedModel, upstreamApiFormat)
      if (nativeCapabilities.nativeToolSearch) {
        modelOptions[CLOUD_MODEL_NATIVE_TOOL_SEARCH_OPTION] = 'true'
      }
      if (nativeCapabilities.nativeNamespaceTools) {
        modelOptions[CLOUD_MODEL_NATIVE_NAMESPACE_TOOLS_OPTION] = 'true'
      }
    }
    const codexCatalogModelId = cloudCodexCatalogModelId(selectedModel)
    if (codexCatalogModelId) {
      modelOptions[CLOUD_MODEL_CODEX_CATALOG_MODEL_ID_OPTION] = codexCatalogModelId
    }
    const visionSidecar = parseCloudVisionSidecarReference(
      selectedModel.config?.[CLOUD_VISION_SIDECAR_CONFIG_KEY]
    )
    if (visionSidecar) {
      modelOptions[CLOUD_MODEL_VISION_SIDECAR_OPTION] = JSON.stringify(visionSidecar)
    }

    const contextWindow =
      selectedModel.contextWindow ??
      selectedModel.config?.model_context_window ??
      selectedModel.config?.context_window ??
      selectedModel.config?.contextWindow
    if (
      (typeof contextWindow === 'number' && contextWindow > 0) ||
      (typeof contextWindow === 'string' && Number(contextWindow) > 0)
    ) {
      modelOptions[CLOUD_MODEL_CONTEXT_WINDOW_OPTION] = String(contextWindow)
    }

    const maxOutputTokens =
      selectedModel.maxOutputTokens ??
      selectedModel.config?.max_output_tokens ??
      selectedModel.config?.maxOutputTokens
    if (
      (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) ||
      (typeof maxOutputTokens === 'string' && Number(maxOutputTokens) > 0)
    ) {
      modelOptions[CLOUD_MODEL_MAX_OUTPUT_TOKENS_OPTION] = String(maxOutputTokens)
    }
  }
  return {
    modelId: executionModel.modelName,
    modelType: executionModel.modelType,
    modelOptions,
  }
}
