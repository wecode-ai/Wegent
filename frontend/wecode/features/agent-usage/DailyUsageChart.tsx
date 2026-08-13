// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { UsageDailyRow } from '@wecode/api/agent-usage'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type MetricKey = 'pv' | 'uv' | 'ai_rounds' | 'completed_ai_rounds'

interface ChartMetric {
  key: MetricKey
  label: string
  dashed?: boolean
}

interface ChartAgent {
  key: string
  name: string
  namespace: string
  colorClassName: string
}

interface ChartPoint {
  date: string
  pv: number
  uv: number
  ai_rounds?: number
  completed_ai_rounds?: number
}

interface DailyUsageChartProps {
  rows: UsageDailyRow[]
  showAiMetrics: boolean
  labels: {
    usageTrend: string
    aiTrend: string
    pv: string
    uv: string
    aiRounds: string
    completedAiRounds: string
    selectAgents: string
    shownAgents: string
    topAgents: string
    selectAll: string
    clearAll: string
  }
}

const chartWidth = 800
const chartHeight = 220
const plotLeft = 52
const plotRight = 16
const plotTop = 16
const plotBottom = 20
const defaultAgentCount = 5
const agentColors = [
  'text-primary',
  'text-success',
  'text-warning',
  'text-link',
  'text-error',
  'text-text-secondary',
]

function agentKey(row: Pick<UsageDailyRow, 'agent_namespace' | 'agent_name'>): string {
  return `${row.agent_namespace}\u0000${row.agent_name}`
}

function seriesValue(row: ChartPoint, key: MetricKey): number {
  return row[key] ?? 0
}

export function buildLinePoints(rows: ChartPoint[], key: MetricKey, maxValue: number): string {
  const plotWidth = chartWidth - plotLeft - plotRight
  const plotHeight = chartHeight - plotTop - plotBottom
  return rows
    .map((row, index) => {
      const x =
        plotLeft + (rows.length === 1 ? plotWidth / 2 : (index / (rows.length - 1)) * plotWidth)
      const y = plotTop + plotHeight - (seriesValue(row, key) / maxValue) * plotHeight
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

function toggleSetValue<T>(values: Set<T>, value: T): Set<T> {
  const next = new Set(values)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}

function ChartPanel({
  title,
  rows,
  dates,
  agents,
  metrics,
}: {
  title: string
  rows: UsageDailyRow[]
  dates: string[]
  agents: ChartAgent[]
  metrics: ChartMetric[]
}) {
  const [hiddenMetrics, setHiddenMetrics] = useState<Set<MetricKey>>(new Set())
  const visibleMetrics = metrics.filter(metric => !hiddenMetrics.has(metric.key))
  const rowsByAgentAndDate = useMemo(
    () => new Map(rows.map(row => [`${agentKey(row)}\u0000${row.date}`, row])),
    [rows]
  )
  const agentSeries = useMemo(
    () =>
      agents.map(agent => ({
        agent,
        rows: dates.map(date => {
          const row = rowsByAgentAndDate.get(`${agent.key}\u0000${date}`)
          return {
            date,
            pv: row?.pv ?? 0,
            uv: row?.uv ?? 0,
            ai_rounds: row?.ai_rounds ?? 0,
            completed_ai_rounds: row?.completed_ai_rounds ?? 0,
          }
        }),
      })),
    [agents, dates, rowsByAgentAndDate]
  )
  const maxValue = Math.max(
    1,
    ...agentSeries.flatMap(({ rows: seriesRows }) =>
      seriesRows.flatMap(row => visibleMetrics.map(metric => seriesValue(row, metric.key)))
    )
  )
  const midpoint = Math.round(maxValue / 2)
  const firstDate = dates[0] ?? ''
  const middleDate = dates[Math.floor((dates.length - 1) / 2)] ?? ''
  const lastDate = dates.at(-1) ?? ''
  const showPoints = dates.length <= 31

  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-medium text-text-primary">{title}</h4>
        <div className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
          {metrics.map(metric => {
            const visible = !hiddenMetrics.has(metric.key)
            return (
              <button
                key={metric.key}
                type="button"
                data-testid={`agent-usage-toggle-${metric.key}`}
                aria-pressed={visible}
                className={cn(
                  'inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-muted hover:text-text-primary',
                  !visible && 'opacity-45'
                )}
                onClick={() => setHiddenMetrics(previous => toggleSetValue(previous, metric.key))}
              >
                <span
                  className={cn(
                    'h-0.5 w-5 rounded-full bg-text-secondary',
                    metric.dashed && 'border-t border-dashed border-text-secondary bg-transparent'
                  )}
                />
                {metric.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-base px-3 py-3">
        <svg
          data-testid={`agent-usage-chart-${metrics.map(metric => metric.key).join('-')}`}
          className="h-56 w-full"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          role="img"
          aria-label={title}
          preserveAspectRatio="none"
        >
          {[plotTop, chartHeight / 2, chartHeight - plotBottom].map(y => (
            <line
              key={y}
              x1={plotLeft}
              x2={chartWidth - plotRight}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeDasharray="4 4"
            />
          ))}
          <text
            x={plotLeft - 8}
            y={plotTop + 4}
            textAnchor="end"
            className="fill-text-muted text-xs"
          >
            {maxValue}
          </text>
          <text
            x={plotLeft - 8}
            y={chartHeight / 2 + 4}
            textAnchor="end"
            className="fill-text-muted text-xs"
          >
            {midpoint}
          </text>
          <text
            x={plotLeft - 8}
            y={chartHeight - plotBottom + 4}
            textAnchor="end"
            className="fill-text-muted text-xs"
          >
            0
          </text>
          {agentSeries.flatMap(({ agent, rows: seriesRows }, agentIndex) =>
            visibleMetrics.map(metric => (
              <g
                key={`${agent.key}-${metric.key}`}
                data-testid={`agent-usage-series-${metric.key}-${agentIndex}`}
                className={agent.colorClassName}
              >
                <polyline
                  points={buildLinePoints(seriesRows, metric.key, maxValue)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeDasharray={metric.dashed ? '7 5' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {showPoints &&
                  seriesRows.map((row, index) => {
                    const [, y] = buildLinePoints([row], metric.key, maxValue).split(',')
                    const plotWidth = chartWidth - plotLeft - plotRight
                    const pointX =
                      plotLeft +
                      (seriesRows.length === 1
                        ? plotWidth / 2
                        : (index / (seriesRows.length - 1)) * plotWidth)
                    return (
                      <circle
                        key={`${metric.key}-${row.date}`}
                        cx={pointX}
                        cy={y}
                        r="3"
                        fill="currentColor"
                      >
                        <title>{`${row.date} · ${agent.name} · ${metric.label}: ${seriesValue(row, metric.key)}`}</title>
                      </circle>
                    )
                  })}
              </g>
            ))
          )}
        </svg>
        <div className="flex justify-between pl-10 text-xs text-text-muted">
          <span>{firstDate}</span>
          {dates.length > 2 && <span>{middleDate}</span>}
          {dates.length > 1 && <span>{lastDate}</span>}
        </div>
      </div>
    </section>
  )
}

export function DailyUsageChart({ rows, showAiMetrics, labels }: DailyUsageChartProps) {
  const dates = useMemo(() => Array.from(new Set(rows.map(row => row.date))).sort(), [rows])
  const agents = useMemo(() => {
    const uniqueAgents = new Map<string, Pick<UsageDailyRow, 'agent_name' | 'agent_namespace'>>()
    const totals = new Map<string, number>()
    rows.forEach(row => {
      const key = agentKey(row)
      uniqueAgents.set(key, row)
      totals.set(key, (totals.get(key) ?? 0) + row.pv)
    })
    return Array.from(uniqueAgents.entries())
      .sort(([firstKey], [secondKey]) => (totals.get(secondKey) ?? 0) - (totals.get(firstKey) ?? 0))
      .map(([key, agent], index) => ({
        key,
        name: agent.agent_name,
        namespace: agent.agent_namespace,
        colorClassName: agentColors[index % agentColors.length],
      }))
  }, [rows])
  const defaultAgentKeys = useMemo(
    () => agents.slice(0, defaultAgentCount).map(agent => agent.key),
    [agents]
  )
  const [selectedAgentKeys, setSelectedAgentKeys] = useState<string[]>(defaultAgentKeys)
  const [selectorOpen, setSelectorOpen] = useState(false)

  useEffect(() => {
    setSelectedAgentKeys(defaultAgentKeys)
  }, [defaultAgentKeys])

  if (rows.length === 0) return null
  const selectedAgents = agents.filter(agent => selectedAgentKeys.includes(agent.key))
  const allSelected = agents.length > 0 && selectedAgentKeys.length === agents.length

  return (
    <div className="space-y-5 px-5 py-5">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap gap-1 text-xs text-text-muted">
          {selectedAgents.map(agent => (
            <span
              key={agent.key}
              title={`${agent.name} · ${agent.namespace}`}
              className="inline-flex min-h-8 max-w-48 items-center gap-1.5 rounded-md bg-surface px-2"
            >
              <span
                className={cn('h-2.5 w-2.5 shrink-0 rounded-full bg-current', agent.colorClassName)}
              />
              <span className="truncate">{agent.name}</span>
            </span>
          ))}
        </div>
        <Popover open={selectorOpen} onOpenChange={setSelectorOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              data-testid="agent-usage-chart-agent-select"
              className="shrink-0 justify-between"
            >
              {labels.shownAgents
                .replace('{{shown}}', String(selectedAgents.length))
                .replace('{{total}}', String(agents.length))}
              <ChevronsUpDown className="ml-2 h-4 w-4 text-text-muted" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-sm font-medium text-text-primary">{labels.selectAgents}</span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="agent-usage-chart-select-all"
                  onClick={() =>
                    setSelectedAgentKeys(allSelected ? [] : agents.map(agent => agent.key))
                  }
                >
                  {allSelected ? labels.clearAll : labels.selectAll}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedAgentKeys(defaultAgentKeys)}
                >
                  {labels.topAgents}
                </Button>
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {agents.map((agent, index) => {
                const checked = selectedAgentKeys.includes(agent.key)
                const toggleAgent = () =>
                  setSelectedAgentKeys(previous => {
                    if (previous.includes(agent.key)) {
                      return previous.filter(key => key !== agent.key)
                    }
                    return [...previous, agent.key]
                  })
                return (
                  <div
                    key={agent.key}
                    className="flex min-h-10 w-full items-center gap-3 rounded-md px-2 hover:bg-muted"
                  >
                    <Checkbox
                      checked={checked}
                      data-testid={`agent-usage-chart-agent-option-${index}`}
                      onCheckedChange={toggleAgent}
                    />
                    <span
                      className={cn(
                        'h-2.5 w-2.5 shrink-0 rounded-full bg-current',
                        agent.colorClassName
                      )}
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={toggleAgent}
                    >
                      <span className="block truncate text-sm text-text-primary">{agent.name}</span>
                      <span className="block truncate text-xs text-text-muted">
                        {agent.namespace}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <ChartPanel
          title={labels.usageTrend}
          rows={rows}
          dates={dates}
          agents={selectedAgents}
          metrics={[
            { key: 'pv', label: labels.pv },
            { key: 'uv', label: labels.uv, dashed: true },
          ]}
        />
        {showAiMetrics && (
          <ChartPanel
            title={labels.aiTrend}
            rows={rows}
            dates={dates}
            agents={selectedAgents}
            metrics={[
              { key: 'ai_rounds', label: labels.aiRounds },
              {
                key: 'completed_ai_rounds',
                label: labels.completedAiRounds,
                dashed: true,
              },
            ]}
          />
        )}
      </div>
    </div>
  )
}
