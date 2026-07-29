// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useTranslation } from '@/hooks/useTranslation'

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
