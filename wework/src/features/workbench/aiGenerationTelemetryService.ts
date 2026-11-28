import type { ChatErrorType } from '@wegent/chat-core/chat-error'
import { track } from '@/telemetry/client'
import { activeRuntimeRunTraceId, mintRuntimeRunTraceId } from '@/telemetry/traceId'
import { toKnownAiModelId, toKnownAiProvider } from '@/telemetry/modelCatalog'
import { recordGenerationOutcome } from './runtimeGenerationOutcome'
import { runtimeConversationKey } from './runtimeConversationCache'
import type { RuntimeContextUsage, RuntimeTaskAddress, UnifiedModel } from '@/types/api'
export interface AiGenerationTelemetryInput {
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
export function createAiGenerationTelemetry(read: () => AiGenerationTelemetryInput) {
  const pending = new Map<string, PendingGeneration>()
  const onAssistantStart = (address: RuntimeTaskAddress, subtaskId: string) => {
    pending.set(generationKey(address, subtaskId), {
      generationId: crypto.randomUUID(),
      startedAt: Date.now(),
      traceId: activeRuntimeRunTraceId(address) ?? mintRuntimeRunTraceId(address),
    })
  }

  const onAssistantFirstToken = (address: RuntimeTaskAddress, subtaskId: string) => {
    const generation = pending.get(generationKey(address, subtaskId))
    if (generation && generation.firstTokenAt === undefined) {
      generation.firstTokenAt = Date.now()
    }
  }

  const onAssistantResponseSize = (
    address: RuntimeTaskAddress,
    subtaskId: string,
    responseSizeBytes: number
  ) => {
    const generation = pending.get(generationKey(address, subtaskId))
    if (generation) {
      generation.responseSizeBytes = responseSizeBytes
    }
  }

  const onAssistantSettled = (
    address: RuntimeTaskAddress,
    subtaskId: string,
    result: 'success' | 'failure' | 'cancelled',
    contextUsage?: RuntimeContextUsage,
    errorType?: ChatErrorType
  ) => {
    const key = generationKey(address, subtaskId)
    const generation = pending.get(key)
    if (!generation) return
    pending.delete(key)
    recordGenerationOutcome(address, result)

    const latencyMs = Math.max(0, Date.now() - generation.startedAt)
    const ttftMs =
      generation.firstTokenAt !== undefined
        ? Math.max(0, generation.firstTokenAt - generation.startedAt)
        : undefined
    const { resolveModel, contextUsageByRuntimeTask, knownModelIds } = read()
    const model = resolveModel(address)
    const usage = contextUsage ?? contextUsageByRuntimeTask[runtimeConversationKey(address)]

    track('$ai_generation', {
      $ai_generation_id: generation.generationId,
      $ai_trace_id: generation.traceId,
      $ai_parent_id: generation.traceId,
      $ai_model: toKnownAiModelId(model?.modelId, knownModelIds),
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
      ...(generation.responseSizeBytes !== undefined && {
        $ai_response_body_size: generation.responseSizeBytes,
      }),
      ...(result === 'failure' && errorType && { error_type: errorType }),
      result,
    })
  }

  return {
    onAssistantStart,
    onAssistantFirstToken,
    onAssistantResponseSize,
    onAssistantSettled,
    dispose: () => pending.clear(),
  }
}
function generationKey(address: RuntimeTaskAddress, subtaskId: string): string {
  return `${runtimeConversationKey(address)}:${subtaskId}`
}
export type AiGenerationTelemetry = ReturnType<typeof createAiGenerationTelemetry>
