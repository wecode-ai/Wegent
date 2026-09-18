import type { RuntimeContextUsage, RuntimeTokenUsageBreakdown } from './runtime'

export const DEFAULT_CONTEXT_COMPACTION_THRESHOLD = 85
export type RuntimeContextUsageMetrics = {
  usedTokens: number
  totalTokens: number
  usedPercent: number
  remainingPercent: number
}
function validTokenCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function usageTokens(breakdown: RuntimeTokenUsageBreakdown | undefined): number | null {
  return validTokenCount(breakdown?.totalTokens) ? breakdown.totalTokens : null
}
export function runtimeContextUsageMetrics(
  usage: RuntimeContextUsage
): RuntimeContextUsageMetrics | null {
  if (!validTokenCount(usage.modelContextWindow) || usage.modelContextWindow <= 0) return null
  const usedTokens = usageTokens(usage.last) ?? usageTokens(usage.total)
  if (usedTokens === null) return null
  const usedPercent = Math.min(
    100,
    Math.max(0, Math.round((usedTokens / usage.modelContextWindow) * 100))
  )
  return {
    usedTokens,
    totalTokens: usage.modelContextWindow,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
  }
}

/** One task's usage. A transcript request cannot overwrite a newer live usage event. */
export function createRuntimeContextUsageStore() {
  let usage: RuntimeContextUsage | null = null
  let revision = 0
  const listeners = new Set<() => void>()
  const publish = (next: RuntimeContextUsage | null) => {
    usage = next
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => usage,
    getRevision: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    receiveLive(next: RuntimeContextUsage) {
      revision += 1
      publish(next)
    },
    receiveTranscript(next: RuntimeContextUsage | null | undefined, requestRevision: number) {
      if (next === undefined || revision !== requestRevision) return
      publish(next)
    },
  }
}
