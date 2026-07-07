import { useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { RuntimeContextUsage } from '@/types/api'

interface ContextUsageIndicatorProps {
  usage?: RuntimeContextUsage
}

export function ContextUsageIndicator({ usage }: ContextUsageIndicatorProps) {
  const { t } = useTranslation('common')
  const metrics = useMemo(() => (usage ? contextUsageMetrics(usage) : null), [usage])

  if (!usage || !metrics) return null

  return (
    <div
      className="group relative flex h-4 w-4 shrink-0 translate-y-[1px] items-center justify-center"
      data-testid="context-usage-indicator"
      aria-label={t('workbench.context_usage_aria', {
        usedPercent: metrics.usedPercent,
        remainingPercent: metrics.remainingPercent,
      })}
    >
      <span
        className={cn(
          'flex h-3 w-3 items-center justify-center rounded-full',
          metrics.usedPercent >= 85 ? 'text-red-500' : 'text-[#a5abb2]'
        )}
        style={{
          background: `conic-gradient(currentColor ${metrics.usedPercent * 3.6}deg, #edf0f2 0deg)`,
        }}
      >
        <span className="h-2 w-2 rounded-full bg-background" />
      </span>
      <div className="pointer-events-none absolute bottom-7 left-1/2 z-popover hidden w-max -translate-x-1/2 rounded-2xl border border-border/70 bg-background px-4 py-3 text-center text-[13px] leading-5 text-text-primary shadow-[0_14px_42px_rgba(15,23,42,0.16)] group-hover:block group-focus-within:block">
        <div className="mb-1 whitespace-nowrap font-light text-text-secondary">
          {t('workbench.context_usage_title')}
        </div>
        <div className="whitespace-nowrap font-light">
          {t('workbench.context_usage_percent', {
            usedPercent: metrics.usedPercent,
            remainingPercent: metrics.remainingPercent,
          })}
        </div>
        <div className="whitespace-nowrap font-light">
          {t('workbench.context_usage_tokens', {
            usedTokens: formatCompactTokens(usage.total.totalTokens),
            totalTokens: formatCompactTokens(usage.modelContextWindow),
          })}
        </div>
      </div>
    </div>
  )
}

function contextUsageMetrics(usage: RuntimeContextUsage) {
  if (usage.modelContextWindow <= 0) return null

  const usedPercent = Math.min(
    100,
    Math.max(0, Math.round((usage.total.totalTokens / usage.modelContextWindow) * 100))
  )

  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
  }
}

function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) return `${formatCompactNumber(value / 1_000_000)}m`
  if (absolute >= 1_000) return `${formatCompactNumber(value / 1_000)}k`
  return `${Math.round(value)}`
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1).replace(/\.0$/, '')
}
