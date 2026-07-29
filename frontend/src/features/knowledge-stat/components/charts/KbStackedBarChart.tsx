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
import type { FieldSchema } from '../../api'
import { CHART_COLORS } from './chart-shared'

interface ChartProps {
  rows: Record<string, unknown>[]
  schema: FieldSchema[]
}

/**
 * Horizontal stacked bar chart for per-KB categorical data.
 * E.g. kb_retrieval_mode_dist: {kb_id, injection_mode, call_count}
 *
 * Y-axis: KB label (sorted by total count descending)
 * X-axis: call count
 * Stacked bars: one color per category (e.g. injection_mode)
 */
export function KbStackedBarChart({ rows, schema }: ChartProps) {
  const stringKey = schema.find(s => s.type === 'string' && s.key !== 'kb_name')?.key
  const valueKey = schema.find(
    s => (s.type === 'int' || s.type === 'float') && !isDimensionKey(s.key)
  )?.key
  const nameKey = schema.find(s => s.key === 'kb_name' && s.type === 'string')?.key

  const { pivoted, categories } = useMemo(() => {
    if (!stringKey || !valueKey) {
      return { pivoted: [], categories: [] }
    }

    // Collect unique categories (e.g. injection_mode values)
    const catSet = new Set<string>()
    const kbTotalMap = new Map<string | number, number>()
    const kbLabelMap = new Map<string | number, string>()

    for (const r of rows) {
      const cat = String(r[stringKey] ?? 'unknown')
      catSet.add(cat)
      const kbId = r.kb_id as string | number
      const val = Number(r[valueKey]) || 0
      kbTotalMap.set(kbId, (kbTotalMap.get(kbId) ?? 0) + val)
      kbLabelMap.set(kbId, nameKey && r[nameKey] ? String(r[nameKey]) : `KB #${kbId}`)
    }

    const categories = Array.from(catSet).sort()

    // Sort KBs by total count descending, take top 20
    const sortedKbIds = Array.from(kbTotalMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id]) => id)

    // Pivot: one row per KB, one column per category
    const kbRowMap = new Map<string | number, Record<string, unknown>>()
    for (const r of rows) {
      const kbId = r.kb_id as string | number
      const cat = String(r[stringKey] ?? 'unknown')
      const val = Number(r[valueKey]) || 0
      if (!kbRowMap.has(kbId)) {
        kbRowMap.set(kbId, { _kb_id: kbId, _kb_label: kbLabelMap.get(kbId) })
      }
      kbRowMap.get(kbId)![cat] = val
    }

    const pivoted = sortedKbIds.map(id => kbRowMap.get(id)!)

    return { pivoted, categories }
  }, [rows, schema, stringKey, valueKey, nameKey])

  if (pivoted.length === 0 || categories.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px] text-text-muted text-sm">
        暂无数据
      </div>
    )
  }

  const chartHeight = Math.max(200, pivoted.length * 32 + 60)

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <RechartsBarChart
        data={pivoted}
        layout="vertical"
        margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--color-border-soft, #e8e8ea)"
          horizontal={false}
        />
        <XAxis
          type="number"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="_kb_label"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={80}
        />
        <RechartsTooltip content={<StackedTooltip />} />
        <Legend iconType="square" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 4 }} />
        {categories.map((cat, i) => (
          <Bar
            key={cat}
            dataKey={cat}
            name={cat}
            fill={CHART_COLORS[i % CHART_COLORS.length]}
            stackId="modes"
            maxBarSize={28}
          />
        ))}
      </RechartsBarChart>
    </ResponsiveContainer>
  )
}

function isDimensionKey(key: string): boolean {
  return key === 'kb_id' || key === 'id' || key === 'run_id' || key === 'user_id'
}

function StackedTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const total = payload.reduce((s, p) => s + (p.value || 0), 0)
  return (
    <div className="rounded-md border border-border bg-base px-3 py-2 shadow-md text-xs">
      <div className="font-medium text-text-primary mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: p.color }} />
          <span className="text-text-secondary">{p.name}:</span>
          <span className="font-medium text-text-primary">
            {p.value != null ? p.value.toLocaleString() : '-'}
          </span>
        </div>
      ))}
      <div className="border-t border-border mt-1 pt-1 flex items-center gap-2">
        <span className="text-text-secondary">合计:</span>
        <span className="font-medium text-text-primary">{total.toLocaleString()}</span>
      </div>
    </div>
  )
}
