// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { MetricResponse } from '../../api'

interface HealthRow {
  kb_id?: number
  kb_name?: string
  health_score?: number | null
  activity_score?: number | null
  index_success_score?: number | null
  enable_score?: number | null
  summary_score?: number | null
  target_date?: string | null
}

const TREND_DAYS = 20

/**
 * Per-day health-score table for a single KB (KB-detail page).
 *
 * The admin page uses the cross-KB Top-20 ranking (HealthScoreTable); the
 * KB-detail page is scoped to one KB, where a ranking would collapse to a
 * single row. Instead this shows that KB's health score over the most
 * recent 20 days (one row per day) so the user can see the trend of the
 * composite score and its four pillars.
 */
export function HealthScoreTrendTable({ response }: { response: MetricResponse }) {
  const { t } = useTranslation('knowledge-stat')
  const rows = (response.rows as unknown as HealthRow[]) ?? []

  const trend = [...rows]
    .filter(r => r.target_date)
    .sort((a, b) => String(b.target_date).localeCompare(String(a.target_date)))
    .slice(0, TREND_DAYS)

  if (trend.length === 0) {
    return (
      <div className="flex items-center justify-center h-[120px] text-sm text-text-muted">
        {t('no_data', 'No data available')}
      </div>
    )
  }

  const fmt = (v: number | null | undefined) => (typeof v === 'number' ? v.toFixed(1) : '—')

  return (
    <div className="overflow-x-auto" data-testid="health-score-trend-table">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-text-muted">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium">{t('table.date', '日期')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('health_score', '健康评分')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('pillar_activity', '活跃度')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('pillar_index', '索引')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('pillar_enable', '启用')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('pillar_summary', '摘要')}</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((r, i) => {
            const score = Number(r.health_score)
            const low = typeof r.health_score === 'number' && score < 50
            return (
              <tr key={`${r.target_date ?? i}`} className="border-t border-border">
                <td className="px-2 py-1.5 text-text-secondary tabular-nums">{r.target_date}</td>
                <td
                  className={`px-2 py-1.5 text-right font-medium tabular-nums ${low ? 'text-red-600' : 'text-text-primary'}`}
                >
                  {fmt(r.health_score)}
                </td>
                <td className="px-2 py-1.5 text-right text-text-secondary tabular-nums">
                  {fmt(r.activity_score)}
                </td>
                <td className="px-2 py-1.5 text-right text-text-secondary tabular-nums">
                  {fmt(r.index_success_score)}
                </td>
                <td className="px-2 py-1.5 text-right text-text-secondary tabular-nums">
                  {fmt(r.enable_score)}
                </td>
                <td className="px-2 py-1.5 text-right text-text-secondary tabular-nums">
                  {fmt(r.summary_score)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
