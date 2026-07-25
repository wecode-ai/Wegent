import type { ModelType, UnifiedModel } from '@/types/api'

const OPENAI_RESPONSES_RUNTIME_FAMILY = 'openai.openai-responses'
const OPENAI_CHAT_COMPLETIONS_RUNTIME_FAMILY = 'openai.openai-chat-completions'
const ANTHROPIC_MESSAGES_RUNTIME_FAMILY = 'claude.anthropic-messages'
const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const OPENAI_CHAT_COMPLETIONS_PROTOCOL = 'openai-chat-completions'
const ANTHROPIC_MESSAGES_PROTOCOL = 'anthropic-messages'
const RESPONSES_API_FORMAT = 'responses'
const CHAT_COMPLETIONS_API_FORMAT = 'chat/completions'

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

export function resolveModelExecutionSelection(model: UnifiedModel): {
  modelName: string
  modelType: ModelType
  modelNamespace?: string
  resourceUserId?: number
} {
  return {
    modelName: model.name,
    modelType: model.type,
    modelNamespace: model.namespace,
    resourceUserId: model.resourceUserId,
  }
}
