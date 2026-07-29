// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import {
  RadarChart as RechartsRadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import type { FieldSchema } from '../../api'
import { CHART_COLORS } from './chart-shared'

interface ChartProps {
  rows: Record<string, unknown>[]
  schema: FieldSchema[]
}

// Dimension keys that label an entity, not a metric axis.
const DIMENSION_KEYS = new Set(['kb_id', 'id', 'run_id', 'user_id', 'namespace'])

/**
 * Radar chart for multi-dimensional quality scores (e.g. kb_health_score).
 *
 * Each numeric schema field (excluding dimension ids and the overall
 * composite score) becomes one radar axis. The first non-dimension string
 * field labels each polygon (e.g. kb_name). Multiple rows render as
 * overlaid polygons for side-by-side comparison.
 */
export function KbRadarChart({ rows, schema }: ChartProps) {
  const { labelKey, axes } = useMemo(() => {
    const numeric = schema.filter(s => s.type === 'float' || s.type === 'int')
    // Pillars exclude the composite total and bare dimension ids.
    const pillars = numeric.filter(s => s.key !== 'health_score' && !DIMENSION_KEYS.has(s.key))
    const label =
      schema.find(s => s.type === 'string' && !DIMENSION_KEYS.has(s.key))?.key ?? 'kb_name'
    return { labelKey: label, axes: pillars }
  }, [schema])

  if (axes.length < 3 || rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px] text-text-muted text-sm">
        Need at least 3 score axes and one row to render a radar chart.
      </div>
    )
  }

  // Radar needs axes as fields on each data point: { axis, <label1>, <label2> }.
  // We pivot rows so each axis is one data point carrying every entity's score.
  const labelByIndex = rows.map((r, i) => String(r[labelKey] ?? `#${i + 1}`))
  const data = axes.map(axis => {
    const point: Record<string, unknown> = { axis: axis.label }
    rows.forEach((r, ri) => {
      const v = r[axis.key]
      point[labelByIndex[ri]] = typeof v === 'number' ? v : 0
    })
    return point
  })

  return (
    <ResponsiveContainer width="100%" height={300}>
      <RechartsRadarChart data={data} cx="50%" cy="50%" outerRadius="72%">
        <PolarGrid stroke="hsl(var(--border))" />
        <PolarAngleAxis
          dataKey="axis"
          tick={{ fontSize: 11, fill: 'hsl(var(--text-secondary))' }}
        />
        <PolarRadiusAxis
          angle={90}
          domain={[0, 100]}
          tick={{ fontSize: 10, fill: 'hsl(var(--text-muted))' }}
        />
        <RechartsTooltip
          contentStyle={{
            borderRadius: 8,
            border: '1px solid hsl(var(--border))',
            background: 'hsl(var(--bg-base))',
            fontSize: 12,
          }}
        />
        {labelByIndex.length <= 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {labelByIndex.map((label, i) => (
          <Radar
            key={label}
            name={label}
            dataKey={label}
            stroke={CHART_COLORS[i % CHART_COLORS.length]}
            fill={CHART_COLORS[i % CHART_COLORS.length]}
            fillOpacity={labelByIndex.length > 1 ? 0.15 : 0.35}
            strokeWidth={2}
          />
        ))}
      </RechartsRadarChart>
    </ResponsiveContainer>
  )
}
