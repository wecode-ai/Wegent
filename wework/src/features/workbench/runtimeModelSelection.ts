import {
  getCloudModelUpstreamApiFormat,
  resolveModelExecutionSelection,
  supportsCloudExecution,
} from '@/features/cloud-connection/modelExecution'
import { getDefaultModelOptions, normalizeModelOptionAliases } from '@/lib/model-ui'
import type {
  ModelOptions,
  ModelSelectionConfig,
  RuntimeSendRequest,
  UnifiedModel,
} from '@/types/api'

export const CLOUD_MODEL_NAMESPACE_OPTION = 'weworkCloudModelNamespace'
export const CLOUD_MODEL_RESOURCE_USER_ID_OPTION = 'weworkCloudModelResourceUserId'
export const CLOUD_MODEL_CONTEXT_WINDOW_OPTION = 'weworkCloudModelContextWindow'
export const CLOUD_MODEL_MAX_OUTPUT_TOKENS_OPTION = 'weworkCloudModelMaxOutputTokens'
export const CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION = 'weworkCloudModelUpstreamApiFormat'
export const CLOUD_MODEL_CODEX_CATALOG_MODEL_ID_OPTION = 'weworkCloudModelCodexCatalogModelId'

const KIMI_K3_CODEX_CATALOG_MODEL_ID = 'wework-kimi-k3'

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
    }
    const codexCatalogModelId = cloudCodexCatalogModelId(selectedModel)
    if (codexCatalogModelId) {
      modelOptions[CLOUD_MODEL_CODEX_CATALOG_MODEL_ID_OPTION] = codexCatalogModelId
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
