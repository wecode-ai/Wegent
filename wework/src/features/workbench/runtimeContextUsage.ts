import type {
  ModelSelectionConfig,
  ModelType,
  RuntimeContextUsage,
  UnifiedModel,
} from '@/types/api'

const CONTEXT_WINDOW_CONFIG_KEYS = ['model_context_window', 'context_window', 'contextWindow']
const MAX_OUTPUT_TOKENS_CONFIG_KEYS = ['max_output_tokens', 'maxOutputTokens']

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

function firstPositiveConfigInteger(
  config: Record<string, unknown> | null | undefined,
  keys: readonly string[]
): number | null {
  if (!config) {
    return null
  }

  for (const key of keys) {
    const value = positiveInteger(config[key])
    if (value) {
      return value
    }
  }

  return null
}

export function modelContextWindowFromConfig(model?: UnifiedModel | null): number | null {
  return firstPositiveConfigInteger(model?.config, CONTEXT_WINDOW_CONFIG_KEYS)
}

export function modelMaxOutputTokensFromConfig(model?: UnifiedModel | null): number | null {
  return firstPositiveConfigInteger(model?.config, MAX_OUTPUT_TOKENS_CONFIG_KEYS)
}

/**
 * Context window the runtime budgets input against.
 *
 * Upstream providers charge the completion budget against the same window as the input, and
 * the configured output ceiling travels with every request, so the tokens left for the input
 * are `context_window - max_output_tokens`. The executor reserves the same amount when it
 * derives Codex's auto-compaction threshold, so the usage ratio reported here reaches 100% at
 * the point where Codex compacts instead of running past it until the upstream rejects the turn.
 */
export function modelInputTokenBudget(model?: UnifiedModel | null): number | null {
  const contextWindow = modelContextWindowFromConfig(model)
  if (!contextWindow) {
    return null
  }

  const maxOutputTokens = modelMaxOutputTokensFromConfig(model)
  if (!maxOutputTokens || maxOutputTokens >= contextWindow) {
    return contextWindow
  }

  return contextWindow - maxOutputTokens
}

export function applyModelContextWindowOverride(
  usage: RuntimeContextUsage,
  model?: UnifiedModel | null
): RuntimeContextUsage {
  const contextWindow = modelInputTokenBudget(model)
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

  const candidates = models.filter(
    model =>
      model.name === selection.modelName &&
      (!selection.modelType || model.type === selection.modelType)
  )
  const options = selection.options ?? {}
  const codexProviderId = options.codexProviderId
  const modelNamespace = options.weworkCloudModelNamespace
  const resourceUserId = options.weworkCloudModelResourceUserId
  const hasIdentity = Boolean(codexProviderId || modelNamespace || resourceUserId)
  if (!hasIdentity) {
    return candidates[0] ?? null
  }

  return (
    candidates.find(model => {
      const configuredProviderId = stringConfigValue(model.config, 'codexProviderId')
      return (
        (!codexProviderId || configuredProviderId === codexProviderId) &&
        (!modelNamespace || model.namespace === modelNamespace) &&
        (!resourceUserId || String(model.resourceUserId ?? '') === resourceUserId)
      )
    }) ?? null
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

function stringConfigValue(
  config: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  return stringValue(config?.[key])
}

function modelTypeValue(value: unknown): ModelType | null {
  if (value === 'public' || value === 'user' || value === 'group' || value === 'runtime') {
    return value
  }
  return null
}
