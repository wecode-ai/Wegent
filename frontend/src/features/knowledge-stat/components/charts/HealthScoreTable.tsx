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
  stat_date?: string | null
  target_date?: string | null
}

function rowDate(row: HealthRow): string {
  return row.stat_date ?? row.target_date ?? ''
}

const TOP_N = 20

/**
 * Top-N table of KBs by health_score for the admin page.
 *
 * Collapses the multi-day time-series to each KB's latest-day score, then
 * ranks by health_score descending (Top 20) with the four pillar scores
 * as columns. Replaces the radar chart on the admin page, where dozens of
 * KBs would overflow the radar legend.
 */
export function HealthScoreTable({ response }: { response: MetricResponse }) {
  const { t } = useTranslation('knowledge-stat')
  const rows = (response.rows as unknown as HealthRow[]) ?? []

  // Collapse to each KB's latest-day row (rows span multiple days).
  const byKb = new Map<number, HealthRow>()
  const ordered = [...rows].sort((a, b) => rowDate(b).localeCompare(rowDate(a)))
  for (const r of ordered) {
    const id = Number(r.kb_id)
    if (!id || byKb.has(id)) continue
    byKb.set(id, r)
  }

  const ranking = [...byKb.values()]
    .filter(r => typeof r.health_score === 'number' && r.health_score !== null)
    .sort((a, b) => Number(b.health_score) - Number(a.health_score))
    .slice(0, TOP_N)

  if (ranking.length === 0) {
    return (
      <div className="flex items-center justify-center h-[120px] text-sm text-text-muted">
        {t('no_data', 'No data available')}
      </div>
    )
  }

  const fmt = (v: number | null | undefined) => (typeof v === 'number' ? v.toFixed(1) : '—')

  return (
    <div className="overflow-x-auto" data-testid="health-score-table">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-text-muted">
          <tr>
            <th className="px-2 py-1.5 text-left font-medium w-8">#</th>
            <th className="px-2 py-1.5 text-left font-medium">
              {t('health_table.kb_name', '知识库')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">{t('health_score', '健康评分')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('pillar_activity', '活跃度')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('pillar_index', '索引')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('pillar_enable', '启用')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('pillar_summary', '摘要')}</th>
          </tr>
        </thead>
        <tbody>
          {ranking.map((r, i) => {
            const score = Number(r.health_score)
            const low = score < 50
            return (
              <tr key={r.kb_id ?? i} className="border-t border-border">
                <td className="px-2 py-1.5 text-text-muted">{i + 1}</td>
                <td
                  className="px-2 py-1.5 text-text-primary max-w-[220px] truncate"
                  title={r.kb_name ?? `KB #${r.kb_id}`}
                >
                  {r.kb_name ?? `KB #${r.kb_id}`}
                </td>
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
