// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type MetricFilter, type MetricResponse, fetchQualityAlertMetrics } from '../../api'
import { getThreshold, isWarn, isCritical } from '../../thresholds'

interface QualityAlertPanelProps {
  filter: MetricFilter
}

// Alert thresholds. All "*_rate" fields are 0-100 percentages as of
// migration 010 / P1 collector unification. The thresholds below use
// the same 0-100 scale uniformly.
interface AlertItem {
  kbId: number
  severity: 'high' | 'medium'
  metric: string
  message: string
  value: string
  sortValue: number // numeric value for intra-severity sorting
}

// Metrics the panel needs to evaluate alerts. orphan_doc_alert is per-document
// so we count rows per kb_id client-side.
const ALERT_METRICS = [
  'doc_index_failure_rate',
  'kb_zero_chunk_rate',
  'kb_health_score',
  'thin_doc_alert',
  'orphan_doc_alert',
]

export function QualityAlertPanel({ filter }: QualityAlertPanelProps) {
  const { t, i18n } = useTranslation('knowledge-stat')
  const [results, setResults] = useState<Record<string, MetricResponse>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [coverageComplete, setCoverageComplete] = useState(true)

  // Stable string key so array/object identity churn does not refetch.
  const filterKey = JSON.stringify(filter)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    fetchQualityAlertMetrics(filter)
      .then(d => {
        if (!cancelled) {
          setResults(d.results ?? {})
          setCoverageComplete(d.coverage?.complete ?? false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResults({})
          setError(true)
        }
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  // Memoize on results + language (not `t` which changes identity every render).
  const tFn = i18n.getFixedT(i18n.language, 'knowledge-stat') as (k: string, d?: string) => string
  const alerts = useMemo(
    () => computeAlerts(results, tFn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, i18n.language]
  )

  if (loading) {
    return (
      <div
        className="flex items-center justify-center py-6 text-text-muted text-sm"
        data-testid="quality-alert-panel-loading"
      >
        {t('loading', 'Loading...')}
      </div>
    )
  }

  // Show error state — never mask an API failure as "no anomalies".
  if (error) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        data-testid="quality-alert-panel-error"
      >
        <AlertTriangle className="h-4 w-4" />
        {t('quality_alert_load_error', '质量数据加载失败，请稍后重试')}
      </div>
    )
  }

  if (alerts.length === 0 && coverageComplete) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700"
        data-testid="quality-alert-panel-ok"
      >
        <ShieldAlert className="h-4 w-4" />
        {t('quality_alert_none', 'No quality anomalies detected')}
      </div>
    )
  }

  const highCount = alerts.filter(a => a.severity === 'high').length

  // Show top 10 alerts (high severity first, then by sortValue).
  const visibleAlerts = alerts.slice(0, 10)

  return (
    <div
      className="rounded-lg border border-border bg-surface p-4 space-y-3"
      data-testid="quality-alert-panel"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-yellow-600" />
        <h3 className="text-sm font-semibold text-text-primary">
          {t('quality_alert_title', '质量告警')}
        </h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="h-3.5 w-3.5 text-text-muted cursor-help" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-sm whitespace-pre-wrap">
            {t('tooltip.quality_alert', '')}
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-text-muted">
          {alerts.length} {t('quality_alert_items', '项')}
          {highCount > 0 && (
            <span className="ml-2 text-red-600">
              ({highCount} {t('quality_alert_high', '高危')})
            </span>
          )}
        </span>
      </div>
      {!coverageComplete && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-700">
          {t(
            'quality_alert_partial_coverage',
            '孤儿文档明细采用采集上限，本面板可能未覆盖全部孤儿文档；其他质量指标已完整检查。'
          )}
        </div>
      )}
      <div className="space-y-2">
        {visibleAlerts.map((a, i) => (
          <div
            key={`${a.kbId}-${a.metric}-${i}`}
            className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${
              a.severity === 'high' ? 'border-red-200 bg-red-50' : 'border-yellow-200 bg-yellow-50'
            }`}
          >
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                a.severity === 'high' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
              }`}
            >
              {a.severity === 'high'
                ? t('quality_alert_high', '高危')
                : t('quality_alert_medium', '中危')}
            </span>
            <span className="text-text-secondary flex-1 truncate">{a.message}</span>
            <span className="text-xs tabular-nums font-medium text-text-primary">{a.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function computeAlerts(
  results: Record<string, MetricResponse>,
  t: (k: string, d?: string) => string
): AlertItem[] {
  const items: AlertItem[] = []

  // Alert labels per metric for i18n.
  const ALERT_LABELS: Record<string, string> = {
    doc_index_failure_rate: t('alert_index_failure', '索引失败率高'),
    kb_zero_chunk_rate: t('alert_zero_chunk', '零分块率高'),
    kb_health_score: t('alert_low_health', '健康分低'),
    thin_doc_alert: t('alert_thin_doc', '瘦文档占比高'),
    orphan_doc_alert: t('alert_orphan', '孤儿文档多'),
  }

  // Process each alert metric using shared thresholds from thresholds.ts.
  for (const metricName of ALERT_METRICS) {
    const tDef = getThreshold(metricName)
    if (!tDef) continue
    const data = results[metricName]
    if (!data) continue

    if (tDef.isCount) {
      // Count-based: orphan_doc_alert — count rows per kb_id client-side.
      const byKb = new Map<number, number>()
      for (const row of data.rows) {
        const kbId = Number(row.kb_id)
        byKb.set(kbId, (byKb.get(kbId) ?? 0) + 1)
      }
      for (const [kbId, count] of byKb) {
        if (isWarn(count, tDef)) {
          items.push({
            kbId,
            severity: isCritical(count, tDef) ? 'high' : 'medium',
            metric: metricName,
            message: `${ALERT_LABELS[metricName] ?? metricName} KB#${kbId}`,
            value: `${count}`,
            sortValue: count,
          })
        }
      }
      continue
    }

    // Rate/score-based metrics. Time-series collectors may return many days
    // per KB; alerts represent current state, so retain only the latest row
    // for each KB/dimension instead of emitting one alert per historical day.
    const latestRows = latestRowsByEntity(data.rows)
    for (const row of latestRows) {
      const value = row[tDef.fields[0]]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      if (isWarn(value, tDef)) {
        const label = ALERT_LABELS[metricName] ?? metricName
        const kbInfo = row.kb_id != null ? ` KB#${row.kb_id}` : ''
        const nameInfo = row.kb_name ? ` (${row.kb_name})` : ''
        const extInfo = row.file_extension ? `: ${row.file_extension}` : ''
        items.push({
          kbId: row.kb_id != null ? Number(row.kb_id) : -1,
          severity: isCritical(value, tDef) ? 'high' : 'medium',
          metric: metricName,
          message: `${label}${extInfo}${kbInfo}${nameInfo}`,
          value: `${value.toFixed(1)}`,
          sortValue: tDef.lowerIsWorse ? 100 - value : value,
        })
      }
    }
  }

  // Sort: high severity first, then by descending sortValue within each tier.
  return items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1
    return b.sortValue - a.sortValue
  })
}

function latestRowsByEntity(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const latest = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const key = [
      String(row.kb_id ?? 'platform'),
      String(row.file_extension ?? ''),
      String(row.mode ?? ''),
    ].join(':')
    const rowDate = String(row.stat_date ?? row.target_date ?? '')
    const previous = latest.get(key)
    const previousDate = String(previous?.stat_date ?? previous?.target_date ?? '')
    if (!previous || rowDate >= previousDate) latest.set(key, row)
  }
  return [...latest.values()]
}
