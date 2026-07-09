import type { RuntimeContextUsage, RuntimeTokenUsageBreakdown } from '@/types/api'

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
