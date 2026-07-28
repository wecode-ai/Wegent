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
export const CLOUD_MODEL_KIMI_DYNAMIC_TOOLS_OPTION = 'weworkCloudModelKimiDynamicTools'

const KIMI_DYNAMIC_TOOL_MODEL_IDS = new Set(['k3', 'k3-256k', 'kimi-k3'])

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

export function isOfficialCodexModel(model: UnifiedModel): boolean {
  return modelKind(model) === 'codex-official'
}

export function disableCrossProviderModels(
  models: UnifiedModel[],
  activeModel: UnifiedModel | null
): UnifiedModel[] {
  if (!activeModel) return models

  const activeIsOfficialCodex = isOfficialCodexModel(activeModel)
  return models.map(model => {
    if (isOfficialCodexModel(model) === activeIsOfficialCodex || model.compatibilityDisabled) {
      return model
    }
    return {
      ...model,
      compatibilityDisabled: true,
      compatibilityDisabledReason: 'provider_boundary_mismatch',
    }
  })
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

function supportsKimiDynamicTools(model: UnifiedModel): boolean {
  return KIMI_DYNAMIC_TOOL_MODEL_IDS.has(model.modelId?.trim().toLowerCase() ?? '')
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
    const upstreamApiFormat = getCloudModelUpstreamApiFormat(selectedModel)
    if (upstreamApiFormat) {
      modelOptions[CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION] = upstreamApiFormat
    }
    if (supportsKimiDynamicTools(selectedModel)) {
      modelOptions[CLOUD_MODEL_KIMI_DYNAMIC_TOOLS_OPTION] = 'true'
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
