import type { RuntimeContextUsage, UnifiedModel } from '@/types/api'

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

export {
  findModelForSelection,
  modelSelectionFromRuntimeHandle,
} from '@wegent/chat-core/runtime-model-selection'
