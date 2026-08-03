// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type FieldSchema } from '../../api'

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

export const CHART_COLORS_ALPHA = [
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
export const DIMENSION_KEYS = new Set(['kb_id', 'id', 'run_id', 'user_id'])

export interface ChartProps {
  rows: Record<string, unknown>[]
  schema: FieldSchema[]
}

/* -------------------------------------------------------------------------- */
/*  Shared: Custom Tooltip                                                     */
/* -------------------------------------------------------------------------- */

export function ChartTooltip({
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
export function aggregateByXKey(
  rows: Record<string, unknown>[],
  xKey: string,
  ySchemas: FieldSchema[],
  schema: FieldSchema[]
): Record<string, unknown>[] {
  if (rows.length === 0) return []
  // s.key is an English snake_case identifier that never holds a Chinese
  // glyph, so "率" only appears in the display label (e.g. "命中率"). Test
  // the ASCII markers on the key and both ASCII + CJK on the label.
  const rateKeys = new Set(
    ySchemas.filter(s => /rate|ratio/i.test(s.key) || /rate|ratio|率/.test(s.label)).map(s => s.key)
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
