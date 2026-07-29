// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Fragment, useMemo } from 'react'
import {
  LineChart as RechartsLineChart,
  Area,
  Line,
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
/*  Line Chart — gradient area fill, active dots                               */
/* -------------------------------------------------------------------------- */

export function LineChart({ rows, schema }: ChartProps) {
  const xKey =
    schema.find(s => s.type === 'date')?.key ??
    schema.find(s => s.type === 'string' && !DIMENSION_KEYS.has(s.key))?.key ??
    'stat_date'
  const ySchemas = schema.filter(
    s => (s.type === 'int' || s.type === 'float') && !DIMENSION_KEYS.has(s.key)
  )

  const rateKeys = new Set(
    ySchemas
      .filter(s => /rate|ratio|率/i.test(s.key) || /rate|ratio/i.test(s.label))
      .map(s => s.key)
  )

  const aggregatedRows = useMemo(
    () => aggregateByXKey(rows, xKey, ySchemas, schema),
    [rows, xKey, ySchemas, schema]
  )

  // Pre-compute enhanced chart data: for ratio keys, append a `_ma7` column
  // holding the 7-day trailing moving average. Non-ratio keys are left
  // untouched (absolute counts have no spike problem).
  const chartData = useMemo(() => {
    if (aggregatedRows.length === 0) return []
    // Sort by xKey so the MA window is chronologically correct.
    const sorted = [...aggregatedRows].sort((a, b) => {
      const va = String(a[xKey] ?? '')
      const vb = String(b[xKey] ?? '')
      return va < vb ? -1 : va > vb ? 1 : 0
    })
    const window = 7
    return sorted.map((row, idx) => {
      const enhanced: Record<string, unknown> = { ...row }
      for (const key of rateKeys) {
        const start = Math.max(0, idx - window + 1)
        const slice = sorted.slice(start, idx + 1)
        const vals = slice.map(r => Number(r[key])).filter(v => !isNaN(v) && isFinite(v))
        if (vals.length > 0) {
          enhanced[`${key}_ma7`] = vals.reduce((a: number, b: number) => a + b, 0) / vals.length
        }
      }
      return enhanced
    })
  }, [rows, xKey, rateKeys])

  // Render a grey hollow dot for low_confidence data points (sample too
  // small to be trustworthy), and no dot for normal points (keeps the
  // original dot={false} look clean).
  const renderDot = (props: { payload?: Record<string, unknown>; cx?: number; cy?: number }) => {
    const low = Number(props.payload?.low_confidence ?? 0)
    if (!low || props.cx == null || props.cy == null) return <g key="empty" />
    return (
      <circle
        key={`dot-${props.cx}-${props.cy}`}
        cx={props.cx}
        cy={props.cy}
        r={3}
        fill="none"
        stroke="#ccc"
        strokeWidth={1.5}
      />
    )
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <RechartsLineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <defs>
          {ySchemas.map((s, i) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor={CHART_COLORS[i % CHART_COLORS.length]}
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor={CHART_COLORS[i % CHART_COLORS.length]}
                stopOpacity={0}
              />
            </linearGradient>
          ))}
        </defs>
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
          stroke="rgb(var(--color-text-muted, 153 153 153))"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <RechartsTooltip content={<ChartTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        {ySchemas.map((s, _i) => (
          <Area
            key={`area-${s.key}`}
            type="monotone"
            dataKey={s.key}
            stroke="none"
            fill={`url(#grad-${s.key})`}
            legendType="none"
          />
        ))}
        {ySchemas.map((s, i) => {
          const color = CHART_COLORS[i % CHART_COLORS.length]
          const isRate = rateKeys.has(s.key)
          return (
            <Fragment key={s.key}>
              {/* Raw data line: for ratio metrics draw semi-transparent so
                  the MA7 line stands out as the primary signal. */}
              <Line
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={color}
                strokeWidth={isRate ? 1.5 : 2}
                strokeOpacity={isRate ? 0.35 : 1}
                // recharts' dot prop typing does not accept a plain render
                // function; the cast is intentional here.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                dot={renderDot as any}
                activeDot={{
                  r: 4,
                  strokeWidth: 2,
                  stroke: '#fff',
                  fill: color,
                }}
              />
              {/* MA7 smoothing line: only for ratio metrics, dashed and
                  opaque so it reads as the "trend" the eye should follow. */}
              {isRate && (
                <Line
                  type="monotone"
                  dataKey={`${s.key}_ma7`}
                  name={`${s.label} (MA7)`}
                  stroke={color}
                  strokeWidth={2.5}
                  strokeDasharray="5 4"
                  dot={false}
                  activeDot={false}
                />
              )}
            </Fragment>
          )
        })}
      </RechartsLineChart>
    </ResponsiveContainer>
  )
}
