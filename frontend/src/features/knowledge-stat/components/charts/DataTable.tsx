// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { type ChartProps } from './chart-shared'

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
