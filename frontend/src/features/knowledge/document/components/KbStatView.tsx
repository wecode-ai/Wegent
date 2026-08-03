// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useMemo } from 'react'
import { CalendarDays } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { useStatFilter } from '@/features/knowledge-stat/hooks/useStatFilter'
import { StatsPage } from '@/features/knowledge-stat/components/StatsPage'
import { Sparkline } from '@/features/knowledge-stat/components/charts/Charts'
import {
  fetchDashboard,
  fetchMetric,
  type MetricFilter,
  type MetricResponse,
  type StatScope,
  type DashboardResponse,
} from '@/features/knowledge-stat/api'
import { formatStorageSize } from '@/features/knowledge-stat/format-utils'
import { healthTierOf } from '@/features/knowledge-stat/thresholds'

interface KbStatViewProps {
  kbId: number
  kbName: string
  headerActions: React.ReactNode
}

export function KbStatView({ kbId, kbName, headerActions }: KbStatViewProps) {
  const { t } = useTranslation('knowledge-stat')
  const { filter, setStartDate, setEndDate } = useStatFilter()

  const scope: StatScope = { kbId }
  const metricFilter: MetricFilter = {
    start_date: filter.startDate,
    end_date: filter.endDate,
    kb_ids: [kbId],
  }

  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [dashError, setDashError] = useState(false)
  const [health, setHealth] = useState<MetricResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setDashError(false)
    fetchDashboard(scope, metricFilter)
      .then(d => !cancelled && setDashboard(d))
      .catch(() => {
        if (!cancelled) {
          setDashboard(null)
          setDashError(true)
        }
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.startDate, filter.endDate, kbId])

  // Fetch the KB health-score breakdown for the quality summary panel.
  // With date_col=target_date, this returns one row per day — we
  // use the latest for the radar/pillars, and the full series for a
  // 30-day trend line.
  useEffect(() => {
    let cancelled = false
    fetchMetric(scope, 'kb_health_score', metricFilter)
      .then(d => !cancelled && setHealth(d))
      .catch(() => !cancelled && setHealth(null))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.startDate, filter.endDate, kbId])

  // Derive sparkline data arrays from daily_rows. Each card gets a
  // mini trend line showing how that metric changed over the period.
  const sparkData = useMemo(() => {
    if (!dashboard?.daily_rows || dashboard.daily_rows.length < 2) return null
    const rows = [...dashboard.daily_rows].sort((a, b) =>
      (a.stat_date ?? '') < (b.stat_date ?? '') ? -1 : 1
    )
    return {
      total_queries: rows.map(r => r.total_queries ?? 0),
      rag_queries: rows.map(r => r.rag_queries ?? 0),
      kb_head_queries: rows.map(r => r.kb_head_queries ?? 0),
      new_doc_count: rows.map(r => r.new_doc_count ?? 0),
      active_user_count: rows.map(r => r.active_user_count ?? 0),
      direct_injection: rows.map(r => r.direct_injection ?? 0),
    }
  }, [dashboard?.daily_rows])

  // Health-score trend: extract the daily health_score series from the
  // metric response (now that date_col=target_date returns multiple days).
  const healthTrend = useMemo(() => {
    if (!health?.rows || health.rows.length < 2) return null
    const rows = [...health.rows].sort((a, b) =>
      String(a.target_date ?? '') < String(b.target_date ?? '') ? -1 : 1
    )
    return rows
      .map(r => {
        const v = r.health_score
        return typeof v === 'number' ? v : null
      })
      .filter((v): v is number => v !== null)
  }, [health?.rows])

  // The latest health row is used for the radar + pillars display.
  const latestHealthRow = useMemo(() => {
    if (!health?.rows || health.rows.length === 0) return null
    // The card represents the report cutoff, not the most recent historical
    // non-null score. Falling back across missing days makes stale health look
    // current after a KB has been emptied.
    const sorted = [...health.rows].sort((a, b) => {
      const va = String(a.stat_date ?? a.target_date ?? '')
      const vb = String(b.stat_date ?? b.target_date ?? '')
      return va < vb ? 1 : va > vb ? -1 : 0
    })
    return typeof sorted[0]?.health_score === 'number' ? sorted[0] : null
  }, [health?.rows])

  return (
    <div className="space-y-4">
      {/* Header with date filter */}
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-medium text-text-primary truncate">{kbName}</h2>
        </div>
        {headerActions}
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 ml-4">
          <CalendarDays className="h-3.5 w-3.5 text-text-muted shrink-0" />
          <input
            type="date"
            value={filter.startDate}
            onChange={e => setStartDate(e.target.value)}
            max={filter.endDate}
            className="border-0 bg-transparent text-sm tabular-nums focus:outline-none"
            data-testid="stats-filter-date-from"
          />
          <span className="text-text-muted text-xs">—</span>
          <input
            type="date"
            value={filter.endDate}
            onChange={e => setEndDate(e.target.value)}
            min={filter.startDate}
            max={new Date(Date.now() - 86_400_000).toISOString().split('T')[0]}
            className="border-0 bg-transparent text-sm tabular-nums focus:outline-none"
            data-testid="stats-filter-date-to"
          />
        </div>
      </div>

      <hr className="border-border" />

      {/* Dashboard error state — show error instead of silently hiding */}
      {!loading && dashError && (
        <div className="flex items-center justify-center py-10 text-red-500 text-sm rounded-lg border border-red-200 bg-red-50">
          {t('dashboard_load_error', '仪表盘数据加载失败，请稍后重试')}
        </div>
      )}

      {/* KB overview cards — now with sparkline mini-trends */}
      {!loading && !dashError && dashboard?.period_totals && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 gap-3">
          <KbSummaryCard
            value={dashboard.global_totals?.total_doc_count ?? '-'}
            label={t('total_doc_count', '总文档数')}
            colorIndex={0}
          />
          <KbSummaryCard
            value={dashboard.period_totals.period_new_docs}
            label={t('period_new_docs', '新增文档')}
            colorIndex={1}
            sparkline={sparkData?.new_doc_count}
          />
          <KbSummaryCard
            value={dashboard.period_totals.period_total_queries}
            label={t('total_queries', '总查询量')}
            colorIndex={2}
            sparkline={sparkData?.total_queries}
          />
          <KbSummaryCard
            value={dashboard.period_totals.period_kb_head_queries}
            label={t('period_kb_head', '指定文档查询')}
            colorIndex={3}
            sparkline={sparkData?.kb_head_queries}
          />
          <KbSummaryCard
            value={dashboard.period_totals.period_rag_queries}
            label={t('period_rag_queries', 'RAG 查询')}
            colorIndex={4}
            sparkline={sparkData?.rag_queries}
          />
          <KbSummaryCard
            value={dashboard.period_totals.period_direct_inject}
            label={t('period_direct_inject', '直接注入')}
            colorIndex={5}
            sparkline={sparkData?.direct_injection}
          />
          <KbSummaryCard
            value={formatStorageSize(dashboard.global_totals?.total_storage ?? 0)}
            label={t('total_storage', '总存储大小')}
            colorIndex={6}
          />
          <KbSummaryCard
            value={dashboard.daily_rows?.filter(row => (row.total_queries ?? 0) > 0).length ?? 0}
            label={t('retrieval_active_days', '检索活跃天数')}
            colorIndex={7}
          />
        </div>
      )}

      {/* KB quality summary: pillars + 30-day trend line */}
      {latestHealthRow && (
        <div
          className="bg-surface rounded-lg border border-border p-4 grid grid-cols-1 lg:grid-cols-2 gap-4"
          data-testid="kb-quality-summary"
        >
          {/* Pillars (latest day) */}
          <div className="flex flex-col justify-center gap-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-text-secondary">
                {t('quality_summary_title', '知识库健康度')}
              </h3>
              {/* Data freshness: show which day this score belongs to and which
                  run produced it, so users can tell stale data from current. */}
              <span className="text-[10px] text-text-muted tabular-nums">
                {latestHealthRow.stat_date
                  ? t('health_data_as_of', '数据日期 {{date}}', {
                      date: String(latestHealthRow.stat_date).slice(0, 10),
                    })
                  : t('health_data_no_date', '数据日期未知')}
                {health?.run_id != null && (
                  <span className="ml-1" title={health.run_completed_at ?? undefined}>
                    · run #{health.run_id}
                  </span>
                )}
              </span>
            </div>
            <HealthPillarFromRow row={latestHealthRow} />
          </div>
          {/* 30-day health-score trend line */}
          {healthTrend && healthTrend.length >= 2 && (
            <div className="flex flex-col justify-center">
              <h3 className="text-sm font-medium text-text-secondary mb-2">
                {t('health_score_trend', '健康分趋势')}
              </h3>
              <div className="flex-1">
                <Sparkline data={healthTrend} color="#6366F1" />
              </div>
              <p className="text-xs text-text-muted mt-1">
                {t('health_score_trend_hint', '最近 {{n}} 天健康分变化', { n: healthTrend.length })}
              </p>
            </div>
          )}
        </div>
      )}
      {!latestHealthRow && health && !loading && (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
          {t('health_score_no_cutoff_data', '报表截止日无可用健康分')}
        </div>
      )}

      {/* Domain-level metrics (backend filters by scope).
          Grouped by metric type (🔵/🟠/🟣) per v4 §4.3 instead of by
          raw domain, so the KB-detail page reads as three coherent
          sections (RAG tech / knowledge ops / business effect). */}
      <StatsPage scope={scope} filter={metricFilter} hideDashboard groupByType />
    </div>
  )
}

const ACCENT_COLORS = [
  '#14B8A6',
  '#3B82F6',
  '#F59E0B',
  '#EC4899',
  '#6366F1',
  '#10B981',
  '#F97316',
  '#8B5CF6',
]

function KbSummaryCard({
  value,
  label,
  colorIndex,
  sparkline,
}: {
  value: number | string
  label: string
  colorIndex: number
  sparkline?: number[]
}) {
  const color = ACCENT_COLORS[colorIndex % ACCENT_COLORS.length]
  return (
    <div
      className="bg-surface rounded-lg p-4 text-center transition-shadow hover:shadow-sm"
      style={{ borderTopWidth: 3, borderTopColor: color }}
    >
      <div className="text-2xl font-semibold tabular-nums mb-1" style={{ color }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {/* Mini trend line — only when we have >= 2 data points */}
      {sparkline && sparkline.length >= 2 && (
        <div className="h-8 -mx-1 mb-0.5" data-testid={`sparkline-${label}`}>
          <Sparkline data={sparkline} color={color} />
        </div>
      )}
      <div className="text-xs text-text-secondary">{label}</div>
    </div>
  )
}

// Health-score pillars displayed alongside the radar chart in the quality
// summary. Reads a single row (latest day) and renders the composite score
// with a tiered badge plus a per-pillar bar list.
const PILLARS: { key: string; labelKey: string; defaultLabel: string }[] = [
  { key: 'activity_score', labelKey: 'pillar_activity', defaultLabel: '活跃度' },
  { key: 'index_success_score', labelKey: 'pillar_index', defaultLabel: '索引成功率' },
  { key: 'enable_score', labelKey: 'pillar_enable', defaultLabel: '启用率' },
  { key: 'summary_score', labelKey: 'pillar_summary', defaultLabel: '摘要覆盖率' },
]

function HealthPillarFromRow({ row }: { row: Record<string, unknown> }) {
  const { t } = useTranslation('knowledge-stat')
  const score = typeof row?.health_score === 'number' ? row.health_score : null

  // Single source of truth for the 85/70/50 cutoffs (see thresholds.ts).
  const tier = healthTierOf(score)
  const tierLabel = tier.key === 'no_data' ? t('tier_no_data', 'N/A') : t(tier.labelKey, tier.key)

  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-text-primary">
          {score === null ? '—' : score.toFixed(1)}
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tier.cls}`}
        >
          {tierLabel}
        </span>
        <span className="text-xs text-text-muted">
          {score === null ? t('tier_no_data_hint', '空知识库') : '/ 100'}
        </span>
      </div>
      <div className="space-y-2">
        {PILLARS.map(p => {
          const v = typeof row?.[p.key] === 'number' ? (row[p.key] as number) : null
          return (
            <div key={p.key} className="flex items-center gap-2">
              <span className="text-xs text-text-secondary w-24 shrink-0">
                {t(p.labelKey, p.defaultLabel)}
              </span>
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full"
                  style={{ width: `${v === null ? 0 : Math.min(100, v)}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-text-muted w-10 text-right">
                {v === null ? '-' : v.toFixed(0)}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
