// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { type FieldSchema, type MetricResponse } from '../../api'
import {
  LineChart as RechartsLineChart,
  AreaChart as RechartsAreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
  BarChart as RechartsBarChart,
  Bar,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
} from 'recharts'

// Soft, modern palette — low-saturation to match Calm UI
export const CHART_COLORS = [
  '#14B8A6',
  '#F59E0B',
  '#6366F1',
  '#EC4899',
  '#3B82F6',
  '#10B981',
  '#F97316',
  '#8B5CF6',
]

const CHART_COLORS_ALPHA = [
  'rgba(20,184,166,0.15)',
  'rgba(245,158,11,0.15)',
  'rgba(99,102,241,0.15)',
  'rgba(236,72,153,0.15)',
  'rgba(59,130,246,0.15)',
  'rgba(16,185,129,0.15)',
  'rgba(249,115,22,0.15)',
  'rgba(139,92,246,0.15)',
]

// Dimension keys that should not be treated as chart values
const DIMENSION_KEYS = new Set(['kb_id', 'id', 'run_id', 'user_id'])

interface ChartProps {
  rows: Record<string, unknown>[]
  schema: FieldSchema[]
}

/* -------------------------------------------------------------------------- */
/*  Shared: Custom Tooltip                                                     */
/* -------------------------------------------------------------------------- */

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { name: string; value: number; color: string; dataKey?: string }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  // Filter out Area entries (they have dataKey as name, e.g. "total_queries")
  const items = payload.filter(p => p.name !== p.dataKey)
  return (
    <div className="rounded-lg border border-border bg-base px-3 py-2 shadow-lg text-xs">
      {label && <p className="font-medium text-text-primary mb-1">{label}</p>}
      {items.map((p, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span
            className="inline-block h-2 w-2 rounded-full shrink-0"
            style={{ backgroundColor: p.color }}
          />
          <span className="text-text-secondary">{p.name}</span>
          <span className="ml-auto font-medium text-text-primary pl-3">
            {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Shared: aggregate rows by xKey (dimension collapse)                        */
/* -------------------------------------------------------------------------- */

// Aggregate rows by the x-axis key. When a metric has dimension columns
// (e.g. file_extension, kb_id), the same x value may appear in multiple
// rows. For date/string charts we need one point per x:
//  - Absolute counts (call_count, query_count): SUM across dimensions.
//  - Ratio/rate fields (zero_chunk_rate, hit_rate): AVERAGE, not SUM.
//    SUMming two KBs' 30%+40%=70% is meaningless; average (35%) is correct.
// Used by both LineChart and BarChart so they stay consistent.
function aggregateByXKey(
  rows: Record<string, unknown>[],
  xKey: string,
  ySchemas: FieldSchema[],
  schema: FieldSchema[]
): Record<string, unknown>[] {
  if (rows.length === 0) return []
  const rateKeys = new Set(
    ySchemas
      .filter(s => /rate|ratio|率/i.test(s.key) || /rate|ratio/i.test(s.label))
      .map(s => s.key)
  )
  const byX: Record<string, Record<string, unknown>> = {}
  const rateCounters: Record<string, Record<string, number>> = {}
  for (const row of rows) {
    const xVal = String(row[xKey] ?? '')
    if (!byX[xVal]) {
      byX[xVal] = { [xKey]: xVal }
      rateCounters[xVal] = {}
      for (const s of schema) {
        if (s.key !== xKey && s.type === 'string') {
          byX[xVal][s.key] = row[s.key]
        }
      }
    }
    for (const s of ySchemas) {
      const val = Number(row[s.key]) || 0
      if (rateKeys.has(s.key)) {
        const prevSum = Number(byX[xVal][`__${s.key}_sum`]) || 0
        const prevCnt = rateCounters[xVal][s.key] || 0
        byX[xVal][`__${s.key}_sum`] = prevSum + val
        rateCounters[xVal][s.key] = prevCnt + 1
        byX[xVal][s.key] = Math.round(((prevSum + val) / (prevCnt + 1)) * 100) / 100
      } else {
        byX[xVal][s.key] = (Number(byX[xVal][s.key]) || 0) + val
      }
    }
  }
  return Object.values(byX).map(r => {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      if (!k.startsWith('__')) clean[k] = v
    }
    return clean
  })
}

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

/* -------------------------------------------------------------------------- */
/*  Data Table — sticky header, alternating rows, scroll                       */
/* -------------------------------------------------------------------------- */

export function DataTable({ rows, schema }: ChartProps) {
  const { t } = useTranslation('knowledge-stat')

  return (
    <div className="overflow-auto max-h-[360px] rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/60 sticky top-0 z-10">
          <tr>
            {schema.map(s => (
              <th
                key={s.key}
                className="px-3 py-2 text-left font-semibold text-text-secondary whitespace-nowrap"
              >
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={schema.length} className="px-3 py-8 text-center text-text-muted">
                {t('no_data', 'No data available')}
              </td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr
              key={i}
              className={`
                border-b border-border/50 transition-colors
                ${i % 2 === 0 ? 'bg-transparent' : 'bg-muted/20'}
                hover:bg-primary/5
              `}
            >
              {schema.map(s => {
                const val = row[s.key]
                const isNum = s.type === 'int' || s.type === 'float'
                return (
                  <td
                    key={s.key}
                    className={`px-3 py-1.5 whitespace-nowrap ${
                      isNum ? 'text-right tabular-nums font-medium' : ''
                    }`}
                  >
                    {val != null
                      ? isNum
                        ? Number(val).toLocaleString(undefined, {
                            maximumFractionDigits: 2,
                          })
                        : String(val)
                      : '-'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Summary Cards — KPI-style with color accent                                */
/* -------------------------------------------------------------------------- */

export function SummaryCards({ rows, schema }: ChartProps) {
  const numericSchemas = schema.filter(
    s => (s.type === 'int' || s.type === 'float') && !DIMENSION_KEYS.has(s.key)
  )
  const displaySchemas =
    numericSchemas.length > 0 ? numericSchemas : schema.filter(s => s.type !== 'date')

  const row = rows[0] ?? {}

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {displaySchemas.map((s, i) => {
        const value = row[s.key]
        const color = CHART_COLORS[i % CHART_COLORS.length]
        const bgAlpha = CHART_COLORS_ALPHA[i % CHART_COLORS_ALPHA.length]
        return (
          <div
            key={s.key}
            className="relative overflow-hidden rounded-lg border border-border p-3 text-center transition-shadow hover:shadow-sm"
            style={{ borderLeftWidth: 3, borderLeftColor: color }}
          >
            <p className="text-xs text-text-secondary mb-1">{s.label}</p>
            <p className="text-xl font-semibold tabular-nums" style={{ color }}>
              {value != null
                ? s.type === 'float'
                  ? Number(value).toFixed(2)
                  : Number(value).toLocaleString()
                : '-'}
            </p>
            <div
              className="absolute -right-4 -bottom-4 h-16 w-16 rounded-full opacity-30"
              style={{ background: bgAlpha }}
            />
          </div>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Metric Chart — router                                                      */
/* -------------------------------------------------------------------------- */

import { KbRadarChart } from './KbRadarChart'
import { KbStackedBarChart } from './KbStackedBarChart'
import { HealthScoreTable } from './HealthScoreTable'
import { HealthScoreTrendTable } from './HealthScoreTrendTable'

export function MetricChart({
  response,
  chartHint,
}: {
  response: MetricResponse
  chartHint?: string
}) {
  const hint = chartHint || _inferChartHint(response)

  switch (hint) {
    case 'line':
      return <LineChart rows={response.rows} schema={response.schema} />
    case 'bar':
      return <BarChart rows={response.rows} schema={response.schema} />
    case 'pie':
      return <PieChart rows={response.rows} schema={response.schema} />
    case 'cards':
      return <SummaryCards rows={response.rows} schema={response.schema} />
    case 'stacked_bar':
      return <KbStackedBarChart rows={response.rows} schema={response.schema} />
    case 'radar':
      return <KbRadarChart rows={response.rows} schema={response.schema} />
    case 'health_table':
      return <HealthScoreTable response={response} />
    case 'health_trend_table':
      return <HealthScoreTrendTable response={response} />
    default:
      return <DataTable rows={response.rows} schema={response.schema} />
  }
}

function _inferChartHint(response: MetricResponse): string {
  const hasDate = response.schema.some(s => s.type === 'date')
  const numericFields = response.schema.filter(s => s.type === 'int' || s.type === 'float')
  if (hasDate && numericFields.length > 0) {
    return 'line'
  }
  if (numericFields.length > 0 && !hasDate) {
    const stringFields = response.schema.filter(s => s.type === 'string')
    if (stringFields.length > 0) {
      return 'bar'
    }
  }
  return 'table'
}

/* -------------------------------------------------------------------------- */
/*  Sparkline — mini trend line for KPI cards (no axes, no tooltip)           */
/* -------------------------------------------------------------------------- */

export function Sparkline({ data, color }: { data: number[]; color?: string }) {
  if (!data || data.length < 2) return null

  // Build recharts-compatible data objects.
  const chartData = data.map((v, i) => ({ idx: i, value: v }))
  const stroke = color ?? CHART_COLORS[0]

  return (
    <ResponsiveContainer width="100%" height={32}>
      <RechartsAreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
        <defs>
          <linearGradient id={`spark-${stroke.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={stroke} stopOpacity={0.4} />
            <stop offset="95%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={stroke}
          strokeWidth={1.5}
          fill={`url(#spark-${stroke.replace('#', '')})`}
          dot={false}
          isAnimationActive={false}
        />
      </RechartsAreaChart>
    </ResponsiveContainer>
  )
}

/* -------------------------------------------------------------------------- */
/*  Health Distribution — Stacked Area Chart (platform-level)                 */
/*  Shows KB count by health tier per day. Supports absolute / 100% switch.   */
/* -------------------------------------------------------------------------- */

export interface HealthDistributionRow {
  stat_date: string
  excellent: number
  good: number
  fair: number
  poor: number
  no_data: number
}

const HEALTH_COLORS: Record<string, string> = {
  excellent: '#10B981', // green
  good: '#F59E0B', // yellow
  fair: '#F97316', // orange
  poor: '#EF4444', // red
  no_data: '#9CA3AF', // gray
}

export function HealthDistributionChart({ data }: { data: HealthDistributionRow[] }) {
  const { t } = useTranslation('knowledge-stat')
  const [mode, setMode] = useState<'count' | 'percent'>('percent')

  if (!data || data.length === 0) return null

  const tiers = ['excellent', 'good', 'fair', 'poor', 'no_data'] as const

  // i18n keys for health tiers — use existing tier_excellent etc. keys
  // with range suffixes specific to this chart.
  const tierNames: Record<string, string> = {
    excellent: t('tier_excellent_short', '优(≥85)'),
    good: t('tier_good_short', '良(70-84)'),
    fair: t('tier_fair_short', '中(50-69)'),
    poor: t('tier_poor_short', '差(<50)'),
    no_data: t('tier_no_data', '无数据'),
  }

  return (
    <div data-testid="health-distribution-chart">
      {/* View toggle: count (absolute) vs percent (100% stacked) */}
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => setMode('percent')}
          className={`text-xs px-2 py-0.5 rounded ${
            mode === 'percent' ? 'bg-primary text-primary-foreground' : 'bg-muted text-text-muted'
          }`}
        >
          {t('knowledge-stat:chart_percent_mode', '百分比')}
        </button>
        <button
          type="button"
          onClick={() => setMode('count')}
          className={`text-xs px-2 py-0.5 rounded ${
            mode === 'count' ? 'bg-primary text-primary-foreground' : 'bg-muted text-text-muted'
          }`}
        >
          {t('knowledge-stat:chart_count_mode', '绝对数量')}
        </button>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <RechartsAreaChart
          data={data}
          stackOffset={mode === 'percent' ? 'expand' : 'none'}
          margin={{ top: 8, right: 8, bottom: 0, left: -8 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-border-soft, #e8e8ea)"
            vertical={false}
          />
          <XAxis
            dataKey="stat_date"
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
            width={45}
            tickFormatter={v => (mode === 'percent' ? `${Math.round(v * 100)}%` : v)}
          />
          <RechartsTooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              // recharts' stackOffset="expand" normalizes the rendered
              // area and Y axis but leaves tooltip payload.value as the
              // RAW tier count — so p.value*100 yields 2500% for a tier
              // with 25 KBs. Recompute the percentage from the original
              // data row (p.payload) so it is always 0-100%.
              const row = (payload[0]?.payload ?? {}) as Record<string, unknown>
              const total = tiers.reduce((sum, k) => sum + (Number(row[k]) || 0), 0)
              return (
                <div className="rounded-lg border border-border bg-base px-3 py-2 shadow-lg text-xs">
                  <p className="font-medium text-text-primary mb-1">{label}</p>
                  {payload.map((p, i) => {
                    const tier = String(p.dataKey)
                    const raw = Number(row[tier]) || 0
                    const pct = total > 0 ? (raw / total) * 100 : 0
                    return (
                      <div key={i} className="flex items-center gap-2 py-0.5">
                        <span
                          className="inline-block h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: p.color }}
                        />
                        <span className="text-text-secondary">{p.name}</span>
                        <span className="ml-auto font-medium tabular-nums">
                          {mode === 'percent' ? `${pct.toFixed(1)}% (${raw})` : raw}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )
            }}
          />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
          {tiers.map(tier => {
            return (
              <Area
                key={tier}
                type="monotone"
                dataKey={tier}
                name={tierNames[tier]}
                stackId="1"
                stroke={HEALTH_COLORS[tier]}
                fill={HEALTH_COLORS[tier]}
                fillOpacity={0.6}
              />
            )
          })}
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  )
}
