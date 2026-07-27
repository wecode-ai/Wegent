// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Info } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { MetricFilter, MetricResponse, StatScope } from '../api'
import { useMetricData } from '../hooks/useMetricData'
import { ACTION_HINT_LEVEL_CLASS, getActionHint } from '../action-hints'
import { METRIC_TYPE_META, type MetricType } from '../metric-groups'
import { MetricChart } from './charts/Charts'

interface MetricCardProps {
  scope: StatScope
  name: string
  label?: string
  filter: MetricFilter
  chartHint?: string
  description?: string
  rowLimit?: number
  /** null = static snapshot; non-null = time-series. Drives the
   *  "sliding window" vs "current snapshot" badge. */
  dateCol?: string | null
  /** Pre-fetched data from a batch request (preferred when present). */
  data?: MetricResponse
  /** Loading state from the parent batch request, if any. */
  batchLoading?: boolean
  /** Error from the parent batch request, if any. */
  batchError?: Error | null
  /** Metric type chip (🔵/🟠/🟣). Optional — when omitted no chip shows. */
  type?: MetricType
}

export function MetricCard({
  scope,
  name,
  label,
  filter,
  chartHint,
  description,
  rowLimit,
  dateCol,
  data,
  batchLoading,
  batchError,
  type,
}: MetricCardProps) {
  const { t } = useTranslation('knowledge-stat')

  // When the parent supplies batch data, use it directly (no per-card
  // fetch). Otherwise fall back to an individual request so callers that
  // render a single card (e.g. drill-down views) keep working unchanged.
  // `enabled={false}` short-circuits the fallback hook's network call while
  // still satisfying the rules-of-hooks (no conditional hook calls).
  const hasBatchData = data !== undefined
  const fallback = useMetricData(scope, name, filter, !hasBatchData)
  const dataResolved = hasBatchData ? data : fallback.data
  const loading = hasBatchData ? !!batchLoading : fallback.loading
  const error = hasBatchData ? batchError : fallback.error

  // Derive the lookback window (in days) from the filter for the badge.
  const lookbackDays = (() => {
    if (!filter.start_date || !filter.end_date) return null
    const s = new Date(filter.start_date)
    const e = new Date(filter.end_date)
    const diff = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24))
    return diff > 0 ? diff + 1 : 1
  })()

  const hint = getActionHint(name, dataResolved ?? undefined)
  const typeMeta = type ? METRIC_TYPE_META[type] : null

  // The radar chart only works for a single KB on a single day. The admin
  // page returns every KB across many days (dozens of polygons, legend
  // overflow); the KB-detail page returns one KB across many days (one
  // polygon per day, also messy). Switch both to tables:
  //   - admin      -> Top-20 KB ranking (HealthScoreTable)
  //   - KB-detail  -> 20-day per-day trend (HealthScoreTrendTable)
  const effectiveChartHint =
    name === 'kb_health_score'
      ? scope === 'admin'
        ? 'health_table'
        : 'health_trend_table'
      : chartHint

  return (
    <div
      className="bg-surface rounded-lg border border-border p-4 transition-shadow hover:shadow-md"
      data-testid={`metric-card-${name}`}
    >
      <div className="flex items-center gap-1.5 mb-3">
        <h3 className="text-sm font-medium text-text-secondary">
          {t(`metrics.${name}`, label || name)}
        </h3>
        {typeMeta && (
          <span
            className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${typeMeta.chipClass}`}
            data-testid={`metric-type-${name}`}
          >
            {t(typeMeta.labelKey, typeMeta.bullet)}
          </span>
        )}
        {rowLimit &&
          (chartHint === 'table' || chartHint === 'stacked_bar' || chartHint === 'pie') && (
            <span className="text-[10px] font-medium text-primary bg-primary/10 rounded px-1.5 py-0.5">
              Top {rowLimit}
            </span>
          )}
        {/* Time-scope badge: tells the user whether the time-range
            selector affects this card (prevents the "I changed the date
            but nothing happened" confusion on snapshot metrics). */}
        {dateCol ? (
          <span
            className="text-[10px] font-medium text-blue-600 bg-blue-50 rounded px-1.5 py-0.5"
            data-testid={`metric-badge-ts-${name}`}
          >
            {lookbackDays
              ? t('badge_sliding_window', '近{{days}}天滑动', { days: lookbackDays })
              : t('badge_time_series', '时序')}
          </span>
        ) : (
          <span
            className="text-[10px] font-medium text-text-muted bg-muted rounded px-1.5 py-0.5"
            data-testid={`metric-badge-snapshot-${name}`}
          >
            {t('badge_snapshot', '当前截面')}
          </span>
        )}
        {description && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-text-muted shrink-0 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-sm whitespace-pre-wrap">
              {description}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {hint && (
        <div
          className={`mb-3 flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-medium ${ACTION_HINT_LEVEL_CLASS[hint.level]}`}
          data-testid={`metric-hint-${name}`}
        >
          {t(hint.textKey, '', hint.params)}
        </div>
      )}
      {loading && <LoadingSkeleton />}
      {error && (
        <div className="flex items-center justify-center h-[200px] text-red-500 text-sm">
          {error.message}
        </div>
      )}
      {dataResolved && !loading && (
        <MetricChart response={dataResolved} chartHint={effectiveChartHint} />
      )}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse" aria-hidden>
      <div className="h-3 w-1/3 rounded bg-muted" />
      <div className="h-3 w-2/3 rounded bg-muted" />
      <div className="h-[180px] w-full rounded bg-muted/50" />
    </div>
  )
}
