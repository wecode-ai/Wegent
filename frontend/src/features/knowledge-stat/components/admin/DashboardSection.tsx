// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type MetricFilter, type DashboardResponse, fetchDashboard } from '../../api'
import { formatStorageSize } from '../../format-utils'
import { SummaryCard, SummaryGrid, DailyDetailTable } from './DashboardWidgets'
import { LineChart, BarChart, HealthDistributionChart, Sparkline } from '../charts/Charts'

/** Chart title with hover tooltip for explanation. */
function ChartTitle({ title, tooltipKey }: { title: string; tooltipKey: string }) {
  const { t } = useTranslation('knowledge-stat')
  return (
    <h3 className="text-sm font-medium text-text-secondary mb-3 flex items-center gap-1.5">
      {title}
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="h-3.5 w-3.5 text-text-muted cursor-help" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-sm whitespace-pre-wrap">
          {t(tooltipKey, '')}
        </TooltipContent>
      </Tooltip>
    </h3>
  )
}

/** Format a 0-100 percentage value for display. Backend already returns
 *  0-100 (not 0-1), so we only format — no multiplication. */
function formatRate(value: number | null): string {
  if (value == null) return '-'
  return `${value.toFixed(1)}%`
}

interface DashboardSectionProps {
  scope: 'admin' | { kbId: number }
  filter: MetricFilter
}

export function DashboardSection({ scope, filter }: DashboardSectionProps) {
  const { t } = useTranslation('knowledge-stat')
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    fetchDashboard(scope, filter)
      .then(d => !cancelled && setData(d))
      .catch(() => {
        if (!cancelled) {
          setData(null)
          setError(true)
        }
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [JSON.stringify(scope), JSON.stringify(filter)])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        {t('loading', 'Loading...')}
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20 text-red-500 text-sm">
        {t('dashboard_load_error', 'Dashboard data failed to load. Please retry.')}
      </div>
    )
  }

  const hasDingtalk =
    data.global_totals &&
    (data.global_totals.dingtalk_synced_user_count > 0 ||
      data.global_totals.dingtalk_kb_count > 0 ||
      data.global_totals.dingtalk_doc_count > 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-secondary">
            {t('report_period', 'Period')}: {data.report_period.start} ~ {data.report_period.end} (
            {data.report_period.days} {t('days', 'days')})
          </p>
          {data.generated_at && (
            <p className="text-xs text-text-muted mt-1">
              {t('generated_at', 'Generated')}: {data.generated_at}
            </p>
          )}
        </div>
      </div>

      {/* Platform KPI top bar — admin only.
          Event-weighted platform means (SUM(numerator)/SUM(denominator))
          with an inline sparkline per card. Companion to the stacked-area
          health distribution below (v4 §3.2.1). */}
      {scope === 'admin' && <PlatformKpiBar data={data} />}

      {/* Global totals */}
      {data.global_totals && (
        <SummaryGrid title={t('global_totals', 'Global Totals')}>
          <SummaryCard
            index={0}
            value={data.global_totals.total_kb_count}
            label={t('total_kb_count', 'Total KB')}
          />
          <SummaryCard
            index={1}
            value={data.global_totals.total_doc_count}
            label={t('total_doc_count', 'Total Docs')}
          />
          <SummaryCard
            index={2}
            value={formatStorageSize(data.global_totals.total_storage ?? 0)}
            label={t('total_storage', 'Total Storage')}
          />
          {hasDingtalk && (
            <>
              <SummaryCard
                index={3}
                value={data.global_totals.dingtalk_synced_user_count}
                label={t('dt_synced_users', 'DT Synced Users')}
              />
              <SummaryCard
                index={4}
                value={data.global_totals.dingtalk_kb_count}
                label={t('dt_kb_count', 'DT KB')}
              />
              <SummaryCard
                index={5}
                value={data.global_totals.dingtalk_doc_count}
                label={t('dt_doc_count', 'DT Docs')}
              />
            </>
          )}
        </SummaryGrid>
      )}

      {/* Period totals */}
      {data.period_totals && (
        <SummaryGrid title={t('period_totals', 'Period Totals')}>
          <SummaryCard
            index={0}
            value={data.period_totals.period_total_queries}
            label={t('period_total_queries', 'Queries')}
          />
          <SummaryCard
            index={1}
            value={data.period_totals.period_new_kb}
            label={t('period_new_kb', 'New KB')}
          />
          <SummaryCard
            index={2}
            value={data.period_totals.period_new_docs}
            label={t('period_new_docs', 'New Docs')}
          />
          <SummaryCard
            index={3}
            value={data.period_totals.period_rag_queries}
            label={t('period_rag_queries', 'RAG Queries')}
          />
          <SummaryCard
            index={4}
            value={data.period_totals.period_direct_inject}
            label={t('period_direct_inject', 'Direct Injection')}
          />
          <SummaryCard
            index={5}
            value={data.period_totals.period_kb_head_queries}
            label={t('period_kb_head', 'KB Head')}
          />
          <SummaryCard
            index={6}
            value={formatRate(data.period_totals.active_kb_ratio)}
            label={t('active_kb_ratio', 'Active KB Ratio')}
          />
        </SummaryGrid>
      )}

      {/* Charts */}
      {data.daily_rows.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-4">
            <div className="bg-surface rounded-lg border border-border p-4">
              <ChartTitle
                title={t('daily_query_trend', 'Daily Query Trend')}
                tooltipKey="tooltip.daily_query_trend"
              />
              <LineChart
                rows={data.daily_rows as unknown as Record<string, unknown>[]}
                schema={[
                  { key: 'stat_date', type: 'date', label: t('table.date', '日期') },
                  {
                    key: 'total_queries',
                    type: 'int',
                    label: t('table.total_queries', '总查询量'),
                  },
                ]}
              />
            </div>
            <div className="bg-surface rounded-lg border border-border p-4">
              <ChartTitle
                title={t('metrics.doc_upload_trend', '文档上传趋势')}
                tooltipKey="tooltip.doc_upload_trend"
              />
              <LineChart
                rows={data.daily_rows as unknown as Record<string, unknown>[]}
                schema={[
                  { key: 'stat_date', type: 'date', label: t('table.date', '日期') },
                  { key: 'new_doc_count', type: 'int', label: t('table.new_docs', '新增文档') },
                ]}
              />
            </div>
          </div>
          <div className="space-y-4">
            <div className="bg-surface rounded-lg border border-border p-4">
              <ChartTitle
                title={t('kb_statistics', 'KB Statistics')}
                tooltipKey="tooltip.kb_statistics"
              />
              <BarChart
                rows={data.daily_rows as unknown as Record<string, unknown>[]}
                schema={[
                  { key: 'stat_date', type: 'date', label: t('table.date', '日期') },
                  { key: 'new_kb_count', type: 'int', label: t('table.new_kb', '新增知识库') },
                  {
                    key: 'active_kb_count',
                    type: 'int',
                    label: t('table.active_kb', '活跃知识库'),
                  },
                ]}
              />
            </div>
            <div className="bg-surface rounded-lg border border-border p-4">
              <ChartTitle
                title={t('daily_active_users', 'Daily Active Users')}
                tooltipKey="tooltip.daily_active_users"
              />
              <LineChart
                rows={data.daily_rows as unknown as Record<string, unknown>[]}
                schema={[
                  { key: 'stat_date', type: 'date', label: t('table.date', '日期') },
                  {
                    key: 'active_user_count',
                    type: 'int',
                    label: t('table.active_users', '活跃用户'),
                  },
                ]}
              />
            </div>
          </div>
        </div>
      )}

      {/* Platform health distribution (stacked area chart).
          Shows how many KBs are in each health tier per day. This is
          the Simpson's-paradox defense: a single weighted-mean line can
          hide a deteriorating tail, while the stacked area reveals
          distribution shifts. */}
      {data.platform_health_distribution && data.platform_health_distribution.length > 0 && (
        <div
          className="bg-surface rounded-lg border border-border p-4"
          data-testid="platform-health-distribution"
        >
          <ChartTitle
            title={t('platform_health_distribution', '知识库健康度分布趋势')}
            tooltipKey="tooltip.platform_health_distribution"
          />
          <HealthDistributionChart data={data.platform_health_distribution} />
        </div>
      )}

      {/* Detail table */}
      {data.daily_rows.length > 0 && <DailyDetailTable rows={data.daily_rows} />}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Platform KPI top bar — 4 event-weighted platform ratios with sparklines   */
/* -------------------------------------------------------------------------- */

interface RateSeriesPoint {
  stat_date: string
  rate?: number | null
  zero_chunk_rate?: number | null
}

function pickLatestRate(
  series: RateSeriesPoint[] | undefined,
  field: 'rate' | 'zero_chunk_rate'
): { latest: number | null; spark: number[] } {
  if (!series || series.length === 0) return { latest: null, spark: [] }
  const spark: number[] = []
  let latest: number | null = null
  for (const point of series) {
    const v = point[field]
    if (typeof v === 'number' && Number.isFinite(v)) {
      spark.push(v)
      latest = v
    }
  }
  return { latest, spark }
}

function PlatformKpiBar({ data }: { data: DashboardResponse }) {
  const { t } = useTranslation('knowledge-stat')
  const cards = [
    {
      key: 'hit',
      label: t('platform_hit_rate', '平台命中率'),
      tooltipKey: 'tooltip.platform_hit_rate',
      ...pickLatestRate(data.platform_hit_rate, 'rate'),
      color: '#3B82F6',
    },
    {
      key: 'adoption',
      label: t('platform_adoption_rate', '平台采纳率'),
      tooltipKey: 'tooltip.platform_adoption_rate',
      ...pickLatestRate(data.platform_adoption_rate, 'rate'),
      color: '#10B981',
    },
    {
      key: 'zero',
      label: t('platform_zero_chunk_rate', '平台零分块率'),
      tooltipKey: 'tooltip.platform_zero_chunk_rate',
      ...pickLatestRate(
        data.platform_retrieval_quality as unknown as RateSeriesPoint[],
        'zero_chunk_rate'
      ),
      color: '#EF4444',
    },
  ]

  // Basic mode: the backend returns null for every platform series (their
  // collectors are advanced-tier and don't run). Hide the whole bar rather
  // than render three "—" placeholders.
  if (cards.every(c => c.latest === null)) return null

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3" data-testid="platform-kpi-bar">
      {cards.map(card => {
        const hasData = card.latest !== null
        return (
          <div
            key={card.key}
            className="bg-surface rounded-lg border border-border p-3"
            data-testid={`platform-kpi-${card.key}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-text-muted flex items-center gap-1">
                {card.label}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3 w-3 text-text-muted cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-sm whitespace-pre-wrap">
                    {t(card.tooltipKey, '')}
                  </TooltipContent>
                </Tooltip>
              </span>
            </div>
            <div className="mt-1 flex items-end justify-between gap-2">
              <span className="text-xl font-semibold text-text-primary">
                {hasData ? `${card.latest!.toFixed(1)}%` : '—'}
              </span>
              {card.spark.length >= 2 && (
                <div className="w-20 shrink-0">
                  <Sparkline data={card.spark} color={card.color} />
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
