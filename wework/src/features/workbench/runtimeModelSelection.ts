import {
  resolveModelExecutionSelection,
  supportsResponsesApi,
} from '@/features/cloud-connection/modelExecution'
import { getDefaultModelOptions, normalizeModelOptionAliases } from '@/lib/model-ui'
import type {
  ModelOptions,
  ModelSelectionConfig,
  RuntimeSendRequest,
  UnifiedModel,
} from '@/types/api'

const MODEL_EXECUTION_CONFIG_KEY = 'weworkExecution'
export const CLOUD_MODEL_NAMESPACE_OPTION = 'weworkCloudModelNamespace'
export const CLOUD_MODEL_RESOURCE_USER_ID_OPTION = 'weworkCloudModelResourceUserId'
export const CLOUD_MODEL_CONTEXT_WINDOW_OPTION = 'weworkCloudModelContextWindow'
export const CLOUD_MODEL_CATALOG_MODEL_ID_OPTION = 'weworkCloudModelCatalogModelId'

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

function getObjectConfigValue(
  config: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  const value = config?.[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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

function modelExecutionSource(model: UnifiedModel): string {
  const override = getObjectConfigValue(model.config, MODEL_EXECUTION_CONFIG_KEY)
  const source = override?.source
  return typeof source === 'string' ? source : ''
}

function isLocalModel(model: UnifiedModel): boolean {
  return modelExecutionSource(model) === 'local' || model.provider === 'local'
}

function isCloudModel(model: UnifiedModel): boolean {
  const source = modelExecutionSource(model)
  if (source === 'cloud') return true
  if (source === 'local') return false
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
  return supportsResponsesApi(model)
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
  if (codexProviderId) modelOptions.codexProviderId = codexProviderId
  if (codexProviderName) modelOptions.codexProviderName = codexProviderName
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
    if (selectedModel.modelId?.trim()) {
      modelOptions[CLOUD_MODEL_CATALOG_MODEL_ID_OPTION] = selectedModel.modelId.trim()
    }
    const contextWindow =
      selectedModel.config?.model_context_window ??
      selectedModel.config?.context_window ??
      selectedModel.config?.contextWindow
    if (
      (typeof contextWindow === 'number' && contextWindow > 0) ||
      (typeof contextWindow === 'string' && Number(contextWindow) > 0)
    ) {
      modelOptions[CLOUD_MODEL_CONTEXT_WINDOW_OPTION] = String(contextWindow)
    }
  }
  return {
    modelId: executionModel.modelName,
    modelType: executionModel.modelType,
    modelOptions,
  }
}
