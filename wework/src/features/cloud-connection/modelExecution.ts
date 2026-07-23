import type { ModelType, UnifiedModel } from '@/types/api'

const MODEL_EXECUTION_CONFIG_KEY = 'weworkExecution'
const OPENAI_RESPONSES_RUNTIME_FAMILY = 'openai.openai-responses'
const OPENAI_CHAT_COMPLETIONS_RUNTIME_FAMILY = 'openai.openai-chat-completions'
const ANTHROPIC_MESSAGES_RUNTIME_FAMILY = 'claude.anthropic-messages'
const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const OPENAI_CHAT_COMPLETIONS_PROTOCOL = 'openai-chat-completions'
const ANTHROPIC_MESSAGES_PROTOCOL = 'anthropic-messages'
const RESPONSES_API_FORMAT = 'responses'
const CHAT_COMPLETIONS_API_FORMAT = 'chat/completions'

export type HybridModelSource = 'local' | 'cloud'

export interface ModelExecutionOverride {
  source: HybridModelSource
  modelName: string
  modelType: ModelType
  modelNamespace?: string
  resourceUserId?: number
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function supportsResponsesApi(model: UnifiedModel): boolean {
  return getCloudModelUpstreamApiFormat(model) === 'openai-responses'
}

export function getCloudModelUpstreamApiFormat(
  model: UnifiedModel
): 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages' | null {
  const config = recordValue(model.config)
  const family = normalizedString(model.runtime?.family)

  if (
    family === OPENAI_RESPONSES_RUNTIME_FAMILY ||
    normalizedString(config?.protocol) === OPENAI_RESPONSES_PROTOCOL ||
    normalizedString(config?.apiFormat) === RESPONSES_API_FORMAT ||
    normalizedString(config?.api_format) === RESPONSES_API_FORMAT ||
    normalizedString(config?.wire_api) === RESPONSES_API_FORMAT
  ) {
    return 'openai-responses'
  }

  if (
    family === ANTHROPIC_MESSAGES_RUNTIME_FAMILY ||
    family === 'claude' ||
    normalizedString(config?.protocol) === ANTHROPIC_MESSAGES_PROTOCOL ||
    normalizedString(config?.protocol) === 'claude'
  ) {
    return 'anthropic-messages'
  }

  if (
    family === OPENAI_CHAT_COMPLETIONS_RUNTIME_FAMILY ||
    family === 'openai' ||
    normalizedString(config?.protocol) === OPENAI_CHAT_COMPLETIONS_PROTOCOL ||
    normalizedString(config?.protocol) === 'openai' ||
    normalizedString(config?.apiFormat) === CHAT_COMPLETIONS_API_FORMAT ||
    normalizedString(config?.api_format) === CHAT_COMPLETIONS_API_FORMAT ||
    normalizedString(config?.wire_api) === CHAT_COMPLETIONS_API_FORMAT
  ) {
    return 'openai-chat-completions'
  }

  return null
}

export function supportsCloudExecution(model: UnifiedModel): boolean {
  return getCloudModelUpstreamApiFormat(model) !== null
}

export function withModelExecutionOverride(
  model: UnifiedModel,
  override: ModelExecutionOverride
): UnifiedModel {
  return {
    ...model,
    config: {
      ...(model.config ?? {}),
      [MODEL_EXECUTION_CONFIG_KEY]: override,
    },
  }
}

export function getModelExecutionOverride(
  model?: UnifiedModel | null
): ModelExecutionOverride | null {
  const config = recordValue(model?.config)
  const override = recordValue(config?.[MODEL_EXECUTION_CONFIG_KEY])
  if (!override) return null
  if (
    (override.source === 'local' || override.source === 'cloud') &&
    typeof override.modelName === 'string' &&
    (override.modelType === 'public' ||
      override.modelType === 'user' ||
      override.modelType === 'group' ||
      override.modelType === 'runtime')
  ) {
    return {
      source: override.source,
      modelName: override.modelName,
      modelType: override.modelType,
      ...(typeof override.modelNamespace === 'string'
        ? { modelNamespace: override.modelNamespace }
        : {}),
      ...(typeof override.resourceUserId === 'number'
        ? { resourceUserId: override.resourceUserId }
        : {}),
    }
  }
  return null
}

export function resolveModelExecutionSelection(model: UnifiedModel): {
  modelName: string
  modelType: ModelType
  modelNamespace?: string
  resourceUserId?: number
} {
  const override = getModelExecutionOverride(model)
  if (override) {
    return {
      modelName: override.modelName,
      modelType: override.modelType,
      modelNamespace: override.modelNamespace,
      resourceUserId: override.resourceUserId,
    }
  }
  return {
    modelName: model.name,
    modelType: model.type,
    modelNamespace: model.namespace,
    resourceUserId: model.resourceUserId,
  }
}
