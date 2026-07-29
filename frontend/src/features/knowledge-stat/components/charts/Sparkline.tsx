// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useId } from 'react'
import { Area, AreaChart as RechartsAreaChart, ResponsiveContainer } from 'recharts'
import { CHART_COLORS } from './chart-shared'

/* -------------------------------------------------------------------------- */
/*  Sparkline — mini trend line for KPI cards (no axes, no tooltip)           */
/* -------------------------------------------------------------------------- */

export function Sparkline({ data, color }: { data: number[]; color?: string }) {
  // Per-instance id so two same-color Sparklines don't emit a duplicate
  // document-wide gradient id (browsers resolve url(#...) to the first match).
  const gradientId = `spark-${useId().replace(/:/g, '')}`
  if (!data || data.length < 2) return null

  // Build recharts-compatible data objects.
  const chartData = data.map((v, i) => ({ idx: i, value: v }))
  const stroke = color ?? CHART_COLORS[0]

  return (
    <ResponsiveContainer width="100%" height={32}>
      <RechartsAreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={stroke} stopOpacity={0.4} />
            <stop offset="95%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={stroke}
          strokeWidth={1.5}
          fill={`url(#${gradientId})`}
          dot={false}
          isAnimationActive={false}
        />
      </RechartsAreaChart>
    </ResponsiveContainer>
  )
}
