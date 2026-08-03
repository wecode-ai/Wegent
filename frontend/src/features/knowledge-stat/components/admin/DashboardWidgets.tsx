// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { type DailyDashboardRow } from '../../api'

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

interface SummaryCardProps {
  value: number | string
  label: string
  index?: number
}

export function SummaryCard({ value, label, index = 0 }: SummaryCardProps) {
  const color = ACCENT_COLORS[index % ACCENT_COLORS.length]
  return (
    <div
      className="bg-surface rounded-lg p-4 text-center transition-shadow hover:shadow-sm"
      style={{ borderTopWidth: 3, borderTopColor: color }}
    >
      <div className="text-2xl font-semibold tabular-nums mb-1" style={{ color }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="text-xs text-text-secondary">{label}</div>
    </div>
  )
}

interface SummaryGridProps {
  title: string
  children: React.ReactNode
}

export function SummaryGrid({ title, children }: SummaryGridProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-text-secondary">{title}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">{children}</div>
    </div>
  )
}

interface DailyDetailTableProps {
  rows: DailyDashboardRow[]
}

export function DailyDetailTable({ rows }: DailyDetailTableProps) {
  const { t } = useTranslation('knowledge-stat')

  return (
    <div className="max-h-[500px] overflow-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/60 sticky top-0 z-10">
          <tr>
            <th className="px-3 py-2 text-left font-semibold text-text-secondary whitespace-nowrap">
              {t('table.date', 'Date')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.total_queries', 'Total Queries')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.rag_queries', 'RAG')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.direct_injection', 'Direct Injection')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.kb_head_rag', 'KB Head RAG')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.kb_head', 'KB Head')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.active_kb', 'Active KB')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.active_users', 'Active Users')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.new_kb', 'New KB')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.new_docs', 'New Docs')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-text-secondary whitespace-nowrap">
              {t('table.dt_active_users', 'DT Users')}
            </th>
          </tr>
        </thead>
        <tbody>
          {[...rows]
            .sort((a, b) => (b.stat_date || '').localeCompare(a.stat_date || ''))
            .map((row, i) => (
              <tr
                key={row.stat_date}
                className={`
                  border-b border-border/50 transition-colors
                  ${i % 2 === 0 ? 'bg-transparent' : 'bg-muted/20'}
                  hover:bg-primary/5
                `}
              >
                <td className="px-3 py-1.5 whitespace-nowrap">{row.stat_date}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                  {row.total_queries.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.rag_queries.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.direct_injection.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.kb_head_rag_queries.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.kb_head_queries.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.active_kb_count.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.active_user_count.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.new_kb_count.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.new_doc_count.toLocaleString()}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.dingtalk_active_user_count.toLocaleString()}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}
