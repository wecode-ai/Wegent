// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import {
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { useTranslation } from '@/hooks/useTranslation'
import { CHART_COLORS, type ChartProps, ChartTooltip, DIMENSION_KEYS } from './chart-shared'

/* -------------------------------------------------------------------------- */
/*  Pie Chart — donut with center label, legend                                */
/* -------------------------------------------------------------------------- */

export function PieChart({ rows, schema }: ChartProps) {
  const { t } = useTranslation('knowledge-stat')
  const nameKey = schema.find(s => s.type === 'string')?.key ?? 'name'
  const valueKey =
    schema.find(s => (s.type === 'int' || s.type === 'float') && !DIMENSION_KEYS.has(s.key))?.key ??
    'count'

  // When rows contain extra grouping dimensions (e.g. kb_id), aggregate by nameKey
  const aggregated = useMemo(() => {
    const seen = new Map<string, number>()
    for (const r of rows) {
      const name = String(r[nameKey] ?? 'unknown')
      const val = Number(r[valueKey]) || 0
      seen.set(name, (seen.get(name) ?? 0) + val)
    }
    return Array.from(seen, ([name, value]) => ({ [nameKey]: name, [valueKey]: value }))
  }, [rows, nameKey, valueKey])

  const total = rows.reduce((sum, r) => sum + (Number(r[valueKey]) || 0), 0)

  return (
    <ResponsiveContainer width="100%" height={280}>
      <RechartsPieChart>
        <Pie
          data={aggregated}
          dataKey={valueKey}
          nameKey={nameKey}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={95}
          paddingAngle={2}
          strokeWidth={0}
        >
          {aggregated.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        {/* Center label */}
        <text
          x="50%"
          y="47%"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-text-primary text-xl font-semibold"
        >
          {total.toLocaleString()}
        </text>
        <text
          x="50%"
          y="57%"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-text-muted text-xs"
        >
          {t('chart_total', '合计')}
        </text>
        <RechartsTooltip content={<ChartTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 4 }} />
      </RechartsPieChart>
    </ResponsiveContainer>
  )
}
