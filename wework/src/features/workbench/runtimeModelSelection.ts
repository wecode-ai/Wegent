import { resolveModelExecutionSelection } from '@/features/cloud-connection/modelExecution'
import { getModelCompatibilityFamily } from '@/lib/model-ui'
import type { ModelOptions, RuntimeSendRequest, UnifiedModel } from '@/types/api'

const CODEX_RUNTIME_MODEL_NAME = 'codex-gpt-5.5'
const OPENAI_RESPONSES_RUNTIME_FAMILY = 'openai.openai-responses'
const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const RESPONSES_API_FORMAT = 'responses'

function getStringConfigValue(
  config: Record<string, unknown> | null | undefined,
  key: string
): string {
  const value = config?.[key]
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isCodexCompatibleModel(model: UnifiedModel): boolean {
  if (model.name === CODEX_RUNTIME_MODEL_NAME) return true
  return (
    getModelCompatibilityFamily(model) === OPENAI_RESPONSES_RUNTIME_FAMILY ||
    getStringConfigValue(model.config, 'protocol') === OPENAI_RESPONSES_PROTOCOL ||
    getStringConfigValue(model.config, 'apiFormat') === RESPONSES_API_FORMAT ||
    getStringConfigValue(model.config, 'api_format') === RESPONSES_API_FORMAT
  )
}

export function resolveAutomaticModel(models: UnifiedModel[]): UnifiedModel | null {
  return models.find(model => !model.compatibilityDisabled) ?? null
}

export function inferRuntimeName(model: UnifiedModel | null): 'codex' | 'claude_code' {
  if (model && isCodexCompatibleModel(model)) return 'codex'
  return 'claude_code'
}

export function selectedModelExecutionFields(
  selectedModel: UnifiedModel | null,
  selectedModelOptions: ModelOptions
): Pick<RuntimeSendRequest, 'modelId' | 'modelType' | 'modelOptions'> {
  if (!selectedModel) {
    return Object.keys(selectedModelOptions).length > 0
      ? { modelOptions: { ...selectedModelOptions } }
      : {}
  }
  const executionModel = resolveModelExecutionSelection(selectedModel)
  return {
    modelId: executionModel.modelName,
    modelType: executionModel.modelType,
    ...(Object.keys(selectedModelOptions).length > 0
      ? { modelOptions: { ...selectedModelOptions } }
      : {}),
  }
}
