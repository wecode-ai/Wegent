// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { CHART_COLORS, CHART_COLORS_ALPHA, type ChartProps, DIMENSION_KEYS } from './chart-shared'

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
