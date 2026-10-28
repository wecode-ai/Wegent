import type { RuntimeContextUsage, UnifiedModel } from '@/types/api'
import { getCloudModelUpstreamApiFormat } from '@wegent/chat-core/model-execution'

const CONTEXT_WINDOW_CONFIG_KEYS = ['model_context_window', 'context_window', 'contextWindow']
const MAX_OUTPUT_TOKENS_CONFIG_KEYS = ['max_output_tokens', 'maxOutputTokens']
const DEFAULT_PROXY_MAX_OUTPUT_TOKENS = 96_000

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
 * derives Codex's auto-compaction threshold. Automatic compaction starts at 80% of this budget.
 */
export function modelInputTokenBudget(model?: UnifiedModel | null): number | null {
  const contextWindow = modelContextWindowFromConfig(model)
  if (!contextWindow) {
    return null
  }

  const protocol = String(
    model?.config?.upstream_api_format ??
      model?.config?.upstreamApiFormat ??
      (model ? getCloudModelUpstreamApiFormat(model) : '') ??
      ''
  )
    .trim()
    .toLowerCase()
  const proxyOutputBudget = [
    'openai-chat-completions',
    'chat/completions',
    'anthropic-messages',
    'messages',
  ].includes(protocol)
    ? DEFAULT_PROXY_MAX_OUTPUT_TOKENS
    : null
  const maxOutputTokens = modelMaxOutputTokensFromConfig(model) ?? proxyOutputBudget
  if (!maxOutputTokens || maxOutputTokens >= contextWindow) {
    return contextWindow
  }

  return contextWindow - maxOutputTokens
}

export function applyModelContextWindowOverride(
  usage: RuntimeContextUsage,
  model?: UnifiedModel | null
): RuntimeContextUsage {
  const configuredWindow = modelInputTokenBudget(model)
  if (!configuredWindow) {
    return usage
  }

  // The runtime can report a smaller window than the model config allows, for
  // example when a cloud model is served by a compatibility catalog profile.
  // Never raise that window: the ratio must match the budget Codex actually
  // compacts against.
  const runtimeWindow =
    Number.isFinite(usage.modelContextWindow) && usage.modelContextWindow > 0
      ? usage.modelContextWindow
      : null
  const contextWindow = runtimeWindow ? Math.min(runtimeWindow, configuredWindow) : configuredWindow
  if (usage.modelContextWindow === contextWindow) {
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
