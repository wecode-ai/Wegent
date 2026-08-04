import { useCallback, useEffect, useMemo, useRef } from 'react'
import { track } from '@/telemetry/client'
import { runtimeConversationKey } from './runtimeConversationCache'
import type { RuntimeContextUsage, RuntimeTaskAddress, UnifiedModel } from '@/types/api'

interface UseAiGenerationTelemetryInput {
  resolveModel: (address: RuntimeTaskAddress) => UnifiedModel | null
  contextUsageByRuntimeTask: Record<string, RuntimeContextUsage>
}

interface PendingGeneration {
  generationId: string
  startedAt: number
}

interface ModelPricing {
  input: number
  output: number
  cached?: number
}

// Best-effort estimated prices in USD per token. These are approximate and should be
// replaced with backend-supplied costs when available. Missing models simply omit $ai_cost.
const MODEL_PRICING_USD_PER_TOKEN: Record<string, ModelPricing> = {
  'gpt-4o': { input: 2.5 / 1e6, output: 10.0 / 1e6 },
  'gpt-4o-mini': { input: 0.15 / 1e6, output: 0.6 / 1e6 },
  'gpt-4.1': { input: 2.0 / 1e6, output: 8.0 / 1e6 },
  'gpt-4.1-mini': { input: 0.4 / 1e6, output: 1.6 / 1e6 },
  'gpt-4.1-nano': { input: 0.05 / 1e6, output: 0.2 / 1e6 },
  'o3-mini': { input: 1.1 / 1e6, output: 4.4 / 1e6 },
  'o1-mini': { input: 1.1 / 1e6, output: 4.4 / 1e6 },
  'claude-3-5-sonnet': { input: 3.0 / 1e6, output: 15.0 / 1e6 },
  'claude-3-5-haiku': { input: 0.25 / 1e6, output: 1.25 / 1e6 },
  'claude-3-7-sonnet': { input: 3.0 / 1e6, output: 15.0 / 1e6 },
  'gemini-1.5-pro': { input: 1.25 / 1e6, output: 5.0 / 1e6 },
  'gemini-1.5-flash': { input: 0.075 / 1e6, output: 0.3 / 1e6 },
}

function resolveModelPricing(model: UnifiedModel): ModelPricing | undefined {
  const keys = [model.modelId, model.name].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  )
  for (const key of keys) {
    const normalized = key.toLowerCase().replace(/[\s_.-]+/g, '-')
    for (const [pattern, pricing] of Object.entries(MODEL_PRICING_USD_PER_TOKEN)) {
      if (normalized === pattern || normalized.startsWith(`${pattern}-`)) {
        return pricing
      }
    }
  }
  return undefined
}

function estimateGenerationCost(
  model: UnifiedModel,
  usage: RuntimeContextUsage['last'] | undefined
): number | undefined {
  if (!usage) return undefined
  const pricing = resolveModelPricing(model)
  if (!pricing) return undefined

  const inputTokens = Math.max(0, usage.inputTokens)
  const outputTokens = Math.max(0, usage.outputTokens)
  const cachedTokens = Math.max(0, usage.cachedInputTokens)
  const uncachedInputTokens = Math.max(0, inputTokens - cachedTokens)
  const inputCost =
    uncachedInputTokens * pricing.input + cachedTokens * (pricing.cached ?? pricing.input * 0.5)
  const outputCost = outputTokens * pricing.output
  const total = inputCost + outputCost
  return Math.round(total * 1e9) / 1e9
}

export function useAiGenerationTelemetry({
  resolveModel,
  contextUsageByRuntimeTask,
}: UseAiGenerationTelemetryInput) {
  const pendingRef = useRef(new Map<string, PendingGeneration>())
  const resolveModelRef = useRef(resolveModel)
  const contextUsageRef = useRef(contextUsageByRuntimeTask)

  useEffect(() => {
    resolveModelRef.current = resolveModel
    contextUsageRef.current = contextUsageByRuntimeTask
  }, [resolveModel, contextUsageByRuntimeTask])

  const onAssistantStart = useCallback((address: RuntimeTaskAddress) => {
    pendingRef.current.set(runtimeConversationKey(address), {
      generationId: crypto.randomUUID(),
      startedAt: Date.now(),
    })
  }, [])

  const onAssistantSettled = useCallback(
    (address: RuntimeTaskAddress, result: 'success' | 'failure' | 'cancelled') => {
      const key = runtimeConversationKey(address)
      const pending = pendingRef.current.get(key)
      if (!pending) return
      pendingRef.current.delete(key)

      const latencyMs = Math.max(0, Date.now() - pending.startedAt)
      const model = resolveModelRef.current(address)
      const usage = contextUsageRef.current[key]

      const cost = model ? estimateGenerationCost(model, usage?.last) : undefined

      track('$ai_generation', {
        $ai_generation_id: pending.generationId,
        $ai_parent_id: address.taskId,
        $ai_model: model?.modelId ?? model?.name ?? 'unknown',
        $ai_provider: model?.provider ?? 'unknown',
        ...(usage?.last && {
          $ai_input_tokens: usage.last.inputTokens,
          $ai_output_tokens: usage.last.outputTokens,
          $ai_total_tokens: usage.last.totalTokens,
        }),
        $ai_latency: Math.round((latencyMs / 1000) * 1000) / 1000,
        $ai_latency_ms: latencyMs,
        ...(typeof cost === 'number' && { $ai_cost: cost }),
        result,
      })
    },
    []
  )

  return useMemo(
    () => ({ onAssistantStart, onAssistantSettled }),
    [onAssistantStart, onAssistantSettled]
  )
}
