import type {
  ModelExecutionFields,
  ModelOptions,
  ModelSelectionConfig,
  UnifiedModel,
} from '@/types/runtime'

const CLOUD_NAMESPACE = 'weworkCloudModelNamespace'
const CLOUD_RESOURCE_USER = 'weworkCloudModelResourceUserId'
const CLOUD_CONTEXT_WINDOW = 'weworkCloudModelContextWindow'
const CLOUD_MAX_OUTPUT = 'weworkCloudModelMaxOutputTokens'
const CLOUD_API_FORMAT = 'weworkCloudModelUpstreamApiFormat'
const STANDARD_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh']

export function selectableModels(models: UnifiedModel[]): UnifiedModel[] {
  return models.filter(model => model.isActive !== false && !model.compatibilityDisabled)
}

export function defaultModel(models: UnifiedModel[]): UnifiedModel | null {
  const candidates = selectableModels(models)
  return (
    candidates.find(
      model =>
        model.provider === 'local' &&
        modelKind(model) === 'codex-official' &&
        model.config?.codexAuthConfigured === true
    ) ??
    candidates.find(model => model.provider === 'local' && modelKind(model) === 'codex-provider') ??
    candidates.find(
      model => model.provider === 'local' && modelKind(model) === 'model-interface'
    ) ??
    candidates.find(model => model.provider !== 'local') ??
    null
  )
}

export function defaultModelOptions(model: UnifiedModel): ModelOptions {
  const efforts = reasoningEfforts(model)
  const options: ModelOptions = {}
  if (modelSupportsSpeed(model)) options.speed = 'standard'
  if (!efforts.length) return options
  const reasoning = defaultReasoningEffort(model, efforts)
  if (reasoning) options.reasoning = reasoning
  return options
}

export function modelLabel(model: UnifiedModel): string {
  const ui = record(model.config?.ui)
  const label = stringValue(ui.modelLabel) ?? model.displayName ?? model.modelId ?? model.name
  const codexMatch = label.match(/^gpt[-\s]+(\d+(?:\.\d+)?)(?:[-\s]+(.+))?$/i)
  if (!codexMatch) return label
  const suffix = codexMatch[2]
    ?.split(/[-\s]+/)
    .filter(Boolean)
    .map(word => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
  return [codexMatch[1], suffix].filter(Boolean).join(' ')
}

export function reasoningEfforts(model: UnifiedModel): string[] {
  const ui = record(model.config?.ui)
  const configured = ui.reasoningEfforts ?? ui.supportedReasoningEfforts
  const efforts = uniqueStrings(configured)
  const kind = modelKind(model)
  const isModelInterface = kind === 'model-interface' || kind.startsWith('model-interface:')

  if (Array.isArray(configured) && isModelInterface) return efforts
  if (efforts.length) return efforts
  if (
    kind === 'codex-official' ||
    kind === 'codex-provider' ||
    kind.startsWith('codex-provider:') ||
    isModelInterface ||
    kind === 'gpt'
  ) {
    return STANDARD_REASONING_EFFORTS
  }
  return []
}

export function resolvedReasoningEffort(
  model: UnifiedModel | null,
  value: string | undefined
): string | undefined {
  if (!model) return undefined
  const efforts = reasoningEfforts(model)
  if (value && efforts.includes(value)) return value
  return defaultReasoningEffort(model, efforts)
}

export function reasoningLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    none: '无',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最大',
    ultra: 'Ultra',
  }
  return value ? (labels[value] ?? value) : ''
}

export const SPEED_OPTIONS = ['standard', 'fast'] as const

export function speedLabel(value: string | undefined): string {
  return value === 'fast' ? '快速' : '标准'
}

export function modelSupportsSpeed(model: UnifiedModel | null): boolean {
  if (!model) return false
  const ui = record(model.config?.ui)
  const controls = ui.controls ?? ui.supportedControls
  if (Array.isArray(controls)) return controls.includes('speed')
  if (!controls || typeof controls !== 'object') return false
  const speed = (controls as Record<string, unknown>).speed
  if (typeof speed === 'boolean') return speed
  return Boolean(speed && typeof speed === 'object' && !Array.isArray(speed))
}

export function executionFields(
  model: UnifiedModel,
  selectedOptions: ModelOptions
): ModelExecutionFields {
  const options: ModelOptions = {
    ...defaultModelOptions(model),
    ...selectedOptions,
    collaborationMode: selectedOptions.collaborationMode ?? 'default',
  }
  copyStringConfig(model, options, 'codexProviderId')
  copyStringConfig(model, options, 'codexProviderName')
  copyStringConfig(model, options, 'codexProviderType')
  if (model.namespace) options[CLOUD_NAMESPACE] = model.namespace
  if (typeof model.resourceUserId === 'number') {
    options[CLOUD_RESOURCE_USER] = String(model.resourceUserId)
  }
  const format = upstreamApiFormat(model)
  if (format) options[CLOUD_API_FORMAT] = format
  const contextWindow =
    model.contextWindow ??
    numericConfig(model, 'model_context_window', 'context_window', 'contextWindow')
  const maxOutput =
    model.maxOutputTokens ?? numericConfig(model, 'max_output_tokens', 'maxOutputTokens')
  if (contextWindow && contextWindow > 0) options[CLOUD_CONTEXT_WINDOW] = String(contextWindow)
  if (maxOutput && maxOutput > 0) options[CLOUD_MAX_OUTPUT] = String(maxOutput)
  return { modelId: model.name, modelType: model.type, modelOptions: options }
}

export function continuationSelection(fields: ModelExecutionFields): ModelSelectionConfig {
  return {
    modelName: fields.modelId,
    modelType: fields.modelType,
    options: fields.modelOptions,
  }
}

function modelKind(model: UnifiedModel): string {
  const ui = record(model.config?.ui)
  return (stringValue(model.config?.weworkModelKind) ?? stringValue(ui.family) ?? '').toLowerCase()
}

function defaultReasoningEffort(model: UnifiedModel, efforts: string[]): string | undefined {
  const configured = stringValue(record(model.config?.ui).defaultReasoningEffort)?.toLowerCase()
  if (configured && efforts.includes(configured)) return configured
  return efforts.includes('high') ? 'high' : efforts[0]
}

function upstreamApiFormat(model: UnifiedModel): string | null {
  const config = record(model.config)
  const family = normalized(model.runtime?.family)
  const protocol = normalized(config.protocol)
  const format = normalized(config.apiFormat ?? config.api_format ?? config.wire_api)
  if (
    family === 'openai.openai-responses' ||
    protocol === 'openai-responses' ||
    format === 'responses'
  )
    return 'openai-responses'
  if (
    family === 'claude.anthropic-messages' ||
    family === 'claude' ||
    protocol === 'anthropic-messages' ||
    protocol === 'claude'
  )
    return 'anthropic-messages'
  if (
    family === 'openai.openai-chat-completions' ||
    family === 'openai' ||
    protocol === 'openai-chat-completions' ||
    protocol === 'openai' ||
    format === 'chat/completions'
  )
    return 'openai-chat-completions'
  return null
}

function copyStringConfig(model: UnifiedModel, options: ModelOptions, key: string): void {
  const value = stringValue(model.config?.[key])
  if (value) options[key] = value
}

function numericConfig(model: UnifiedModel, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = model.config?.[key]
    const parsed =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean)
    )
  )
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}
