import { useCallback, useEffect, useMemo, useRef } from 'react'
import { track } from '@/telemetry/client'
import { activeRuntimeRunTraceId, mintRuntimeRunTraceId } from '@/telemetry/traceId'
import { toKnownAiModelId, toKnownAiProvider } from '@/telemetry/modelCatalog'
import { recordGenerationOutcome } from './runtimeGenerationOutcome'
import { runtimeConversationKey } from './runtimeConversationCache'
import type { RuntimeContextUsage, RuntimeTaskAddress, UnifiedModel } from '@/types/api'

interface UseAiGenerationTelemetryInput {
  resolveModel: (address: RuntimeTaskAddress) => UnifiedModel | null
  contextUsageByRuntimeTask: Record<string, RuntimeContextUsage>
  knownModelIds: ReadonlySet<string>
}

interface PendingGeneration {
  generationId: string
  startedAt: number
  traceId: string
}

export function useAiGenerationTelemetry({
  resolveModel,
  contextUsageByRuntimeTask,
  knownModelIds,
}: UseAiGenerationTelemetryInput) {
  const pendingRef = useRef(new Map<string, PendingGeneration>())
  const resolveModelRef = useRef(resolveModel)
  const contextUsageRef = useRef(contextUsageByRuntimeTask)
  const knownModelIdsRef = useRef(knownModelIds)

  useEffect(() => {
    resolveModelRef.current = resolveModel
    contextUsageRef.current = contextUsageByRuntimeTask
    knownModelIdsRef.current = knownModelIds
  }, [resolveModel, contextUsageByRuntimeTask, knownModelIds])

  const onAssistantStart = useCallback((address: RuntimeTaskAddress, subtaskId: string) => {
    pendingRef.current.set(generationKey(address, subtaskId), {
      generationId: crypto.randomUUID(),
      startedAt: Date.now(),
      traceId: activeRuntimeRunTraceId(address) ?? mintRuntimeRunTraceId(address),
    })
  }, [])

  const onAssistantSettled = useCallback(
    (
      address: RuntimeTaskAddress,
      subtaskId: string,
      result: 'success' | 'failure' | 'cancelled',
      contextUsage?: RuntimeContextUsage
    ) => {
      const key = generationKey(address, subtaskId)
      const pending = pendingRef.current.get(key)
      if (!pending) return
      pendingRef.current.delete(key)
      recordGenerationOutcome(address, result)

      const latencyMs = Math.max(0, Date.now() - pending.startedAt)
      const model = resolveModelRef.current(address)
      const usage = contextUsage ?? contextUsageRef.current[runtimeConversationKey(address)]

      track('$ai_generation', {
        $ai_generation_id: pending.generationId,
        $ai_trace_id: pending.traceId,
        $ai_parent_id: pending.traceId,
        $ai_model: toKnownAiModelId(model?.modelId, knownModelIdsRef.current),
        $ai_provider: toKnownAiProvider(
          model?.modelId,
          model?.provider,
          model?.config?.weworkModelKind
        ),
        ...(usage?.last && {
          $ai_input_tokens: usage.last.inputTokens,
          $ai_output_tokens: usage.last.outputTokens,
          $ai_total_tokens: usage.last.totalTokens,
        }),
        $ai_latency: Math.round((latencyMs / 1000) * 1000) / 1000,
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

function generationKey(address: RuntimeTaskAddress, subtaskId: string): string {
  return `${runtimeConversationKey(address)}:${subtaskId}`
}
