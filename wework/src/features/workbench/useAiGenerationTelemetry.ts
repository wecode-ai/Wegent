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
  firstTokenAt?: number
  responseSizeBytes?: number
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

  const onAssistantFirstToken = useCallback((address: RuntimeTaskAddress, subtaskId: string) => {
    const pending = pendingRef.current.get(generationKey(address, subtaskId))
    if (pending && pending.firstTokenAt === undefined) {
      pending.firstTokenAt = Date.now()
    }
  }, [])

  const onAssistantResponseSize = useCallback(
    (address: RuntimeTaskAddress, subtaskId: string, responseSizeBytes: number) => {
      const pending = pendingRef.current.get(generationKey(address, subtaskId))
      if (pending) {
        pending.responseSizeBytes = responseSizeBytes
      }
    },
    []
  )

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
      const ttftMs =
        pending.firstTokenAt !== undefined
          ? Math.max(0, pending.firstTokenAt - pending.startedAt)
          : undefined
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
        ...(ttftMs !== undefined && { $ai_time_to_first_token: Math.round(ttftMs) }),
        ...(pending.responseSizeBytes !== undefined && {
          $ai_response_body_size: pending.responseSizeBytes,
        }),
        result,
      })
    },
    []
  )

  return useMemo(
    () => ({
      onAssistantStart,
      onAssistantFirstToken,
      onAssistantResponseSize,
      onAssistantSettled,
    }),
    [onAssistantStart, onAssistantFirstToken, onAssistantResponseSize, onAssistantSettled]
  )
}

function generationKey(address: RuntimeTaskAddress, subtaskId: string): string {
  return `${runtimeConversationKey(address)}:${subtaskId}`
}
