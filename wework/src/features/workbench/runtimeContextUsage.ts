import type {
  ModelSelectionConfig,
  ModelType,
  RuntimeContextUsage,
  UnifiedModel,
} from '@/types/api'

const CONTEXT_WINDOW_CONFIG_KEYS = ['model_context_window', 'context_window', 'contextWindow']

function positiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0) {
    return value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) {
      return null
    }
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }

  return null
}

export function modelContextWindowFromConfig(model?: UnifiedModel | null): number | null {
  const config = model?.config
  if (!config) {
    return null
  }

  for (const key of CONTEXT_WINDOW_CONFIG_KEYS) {
    const contextWindow = positiveInteger(config[key])
    if (contextWindow) {
      return contextWindow
    }
  }

  return null
}

export function applyModelContextWindowOverride(
  usage: RuntimeContextUsage,
  model?: UnifiedModel | null
): RuntimeContextUsage {
  const contextWindow = modelContextWindowFromConfig(model)
  if (!contextWindow || usage.modelContextWindow === contextWindow) {
    return usage
  }

  return {
    ...usage,
    modelContextWindow: contextWindow,
  }
}

export function findModelForSelection(
  models: UnifiedModel[],
  selection?: ModelSelectionConfig | null
): UnifiedModel | null {
  if (!selection?.modelName) {
    return null
  }

  return (
    models.find(
      model =>
        model.name === selection.modelName &&
        (!selection.modelType || model.type === selection.modelType)
    ) ?? null
  )
}

export function modelSelectionFromRuntimeHandle(
  runtimeHandle?: Record<string, unknown> | null
): ModelSelectionConfig | null {
  const selection = recordValue(runtimeHandle?.modelSelection ?? runtimeHandle?.model_selection)
  const modelName = stringValue(selection.modelName) ?? stringValue(selection.model_name)
  if (!modelName) {
    return null
  }

  const modelType = modelTypeValue(selection.modelType) ?? modelTypeValue(selection.model_type)
  const options = recordValue(selection.options)

  return {
    modelName,
    modelType: modelType || null,
    options: Object.fromEntries(
      Object.entries(options)
        .map(([key, optionValue]) => [key, stringValue(optionValue)])
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
    ),
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function modelTypeValue(value: unknown): ModelType | null {
  if (value === 'public' || value === 'user' || value === 'group' || value === 'runtime') {
    return value
  }
  return null
}
