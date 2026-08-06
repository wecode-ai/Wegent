import type { TelemetryResult } from '@/telemetry/events'
import type { RuntimeTaskAddress } from '@/types/api'
import { runtimeConversationKey } from './runtimeConversationCache'

// Run-level lifecycle events (first_response_completed, task_completed, and the
// $ai_trace end) derive their result from the task record, which does not carry
// the assistant-turn outcome: a run whose only generation failed or was
// cancelled can still settle a task with no error set, so those events
// over-report success. The generation hook records the turn outcome here and
// the workbench hook reads it when emitting run-level events, so the run result
// reflects the actual assistant outcome instead of defaulting to success.
const outcomesByRun = new Map<string, TelemetryResult>()

export function recordGenerationOutcome(
  address: RuntimeTaskAddress,
  result: TelemetryResult
): void {
  outcomesByRun.set(runtimeConversationKey(address), result)
}

export function peekGenerationOutcome(address: RuntimeTaskAddress): TelemetryResult | null {
  return outcomesByRun.get(runtimeConversationKey(address)) ?? null
}

export function takeGenerationOutcome(address: RuntimeTaskAddress): TelemetryResult | null {
  const key = runtimeConversationKey(address)
  const outcome = outcomesByRun.get(key)
  if (outcome !== undefined) outcomesByRun.delete(key)
  return outcome ?? null
}

export function resetGenerationOutcomesForTests(): void {
  outcomesByRun.clear()
}
