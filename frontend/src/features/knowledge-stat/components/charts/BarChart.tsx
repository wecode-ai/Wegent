// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import {
  CHART_COLORS,
  type ChartProps,
  ChartTooltip,
  DIMENSION_KEYS,
  aggregateByXKey,
} from './chart-shared'

/* -------------------------------------------------------------------------- */
/*  Bar Chart — rounded corners, hover highlight                               */
/* -------------------------------------------------------------------------- */

export function BarChart({ rows, schema }: ChartProps) {
  const xKey = schema.find(s => s.type === 'date' || s.type === 'string')?.key ?? 'stat_date'
  const ySchemas = schema.filter(
    s => (s.type === 'int' || s.type === 'float') && !DIMENSION_KEYS.has(s.key)
  )
  const rightYKeys = new Set(
    ySchemas.filter(s => s.type === 'float' && /%|率|比例|ratio/i.test(s.label)).map(s => s.key)
  )
  // Collapse dimension rows into one point per x value, matching LineChart.
  // Without this, a metric with a kb_id/injection_mode dimension would render
  // duplicate x-axis labels and side-by-side bars instead of a clean series.
  const aggregatedRows = useMemo(
    () => aggregateByXKey(rows, xKey, ySchemas, schema),
    [rows, xKey, ySchemas, schema]
  )

  return (
    <ResponsiveContainer width="100%" height={280}>
      <RechartsBarChart data={aggregatedRows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--color-border-soft, #e8e8ea)"
          vertical={false}
        />
        <XAxis
          dataKey={xKey}
          stroke="rgb(var(--color-text-muted, 153 153 153))"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          yAxisId="left"
          stroke="rgb(var(--color-text-muted, 153 153 153))"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        {rightYKeys.size > 0 && (
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke="rgb(var(--color-text-muted, 153 153 153))"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
        )}
        <RechartsTooltip content={<ChartTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        {ySchemas.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={CHART_COLORS[i % CHART_COLORS.length]}
            radius={[4, 4, 0, 0]}
            maxBarSize={48}
            yAxisId={rightYKeys.has(s.key) ? 'right' : 'left'}
          />
        ))}
      </RechartsBarChart>
    </ResponsiveContainer>
  )
}
