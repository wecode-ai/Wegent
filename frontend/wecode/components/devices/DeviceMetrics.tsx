// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { AlertTriangle, ChevronDown, Cpu, ExternalLink, HardDrive, MemoryStick } from 'lucide-react'
import type { ComponentType, MouseEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cloudDeviceApis } from '@wecode/apis/cloud-devices'
import type { CloudDeviceMetricsResponse, MetricsHistoryResponse } from '@wecode/apis/cloud-devices'

const REFRESH_INTERVAL_MS = 30_000
const HIGH_USAGE_THRESHOLD = 80
const SCALING_WIKI_URL =
  process.env.NEXT_PUBLIC_CLOUD_DEVICE_SCALING_WIKI_URL ||
  'https://wiki.api.weibo.com/zh/weibo_rd/dev/wecode/wegent-device'

interface DeviceMetricsProps {
  deviceId: string
}

function formatPercent(value: number | null): string {
  if (value === null) return '--'
  if (value < 1) return '<1'
  return Math.round(value).toString()
}

function getColor(value: number | null): string {
  if (value === null) return '#d1d5db'
  if (value >= 80) return '#f87171'
  if (value >= 60) return '#fbbf24'
  return '#409eff'
}

function ResourceMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: number | null
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-3 w-3 text-[#9aa0a6]" />
      <span className="text-xs text-[#6b6f76]">{label}</span>
      <div className="h-1 w-14 overflow-hidden rounded-full bg-[#eeefef]">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${value ?? 0}%`, backgroundColor: getColor(value) }}
        />
      </div>
      <span className="min-w-[28px] text-xs tabular-nums text-[#3c4043]">
        {formatPercent(value)}%
      </span>
    </div>
  )
}

const CHART_COLORS: Record<string, string> = {
  cpu: '#409eff',
  memory: '#6366f1',
  disk: '#f59e0b',
}

function SingleMetricChart({
  label,
  color,
  data,
  minTs,
  tsRange,
}: {
  label: string
  color: string
  data: [number, number][]
  minTs: number
  tsRange: number
}) {
  const width = 280
  const height = 128
  const padLeft = 30
  const padRight = 8
  const padTop = 10
  const padBottom = 24
  const chartW = width - padLeft - padRight
  const chartH = height - padTop - padBottom

  const values = data.map(d => d[1])
  const dataMin = values.length > 0 ? Math.min(...values) : 0
  const dataMax = values.length > 0 ? Math.max(...values) : 100
  const dataRange = dataMax - dataMin
  // When values are nearly constant, dataRange≈0 collapses the y-axis so the
  // three ticks round to the same label (e.g. "22, 22, 23"). Enforce a minimum
  // range to keep ticks distinct and give flat data some visual context.
  const range = Math.max(dataRange, 10)
  const yMin = Math.max(0, dataMin - range * 0.2)
  const yMax = Math.min(100, dataMax + range * 0.3)
  const yRange = yMax - yMin || 1

  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  function buildPath(): string {
    if (data.length < 2) return ''
    return data
      .map((d, i) => {
        const x = padLeft + ((d[0] - minTs) / tsRange) * chartW
        const y = padTop + (1 - (d[1] - yMin) / yRange) * chartH
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }

  function buildArea(): string {
    if (data.length < 2) return ''
    const baseline = padTop + chartH
    const points = data.map(d => {
      const x = padLeft + ((d[0] - minTs) / tsRange) * chartW
      const y = padTop + (1 - (d[1] - yMin) / yRange) * chartH
      return { x, y }
    })
    const first = points[0]
    const last = points[points.length - 1]
    let path = `M${first.x.toFixed(1)},${first.y.toFixed(1)}`
    for (let i = 1; i < points.length; i++) {
      path += ` L${points[i].x.toFixed(1)},${points[i].y.toFixed(1)}`
    }
    path += ` L${last.x.toFixed(1)},${baseline} L${first.x.toFixed(1)},${baseline} Z`
    return path
  }

  const fmt = (ts: number) => {
    const d = new Date(ts * 1000)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  const timeLabelCount = 3
  const timeLabels: { ts: number; x: number }[] = []
  for (let i = 0; i < timeLabelCount; i++) {
    const ts = minTs + (tsRange * i) / (timeLabelCount - 1)
    const x = padLeft + (i / (timeLabelCount - 1)) * chartW
    timeLabels.push({ ts, x })
  }

  const yTickCount = 3
  const yTicks: number[] = []
  for (let i = 0; i < yTickCount; i++) {
    yTicks.push(yMin + (yRange * i) / (yTickCount - 1))
  }

  const path = buildPath()
  const area = buildArea()

  // Hovered data point (nearest to mouse x). Geometry mirrors buildPath mapping.
  const hoverPoint = hover != null ? (data[hover] ?? null) : null
  const hoverX = hoverPoint ? padLeft + ((hoverPoint[0] - minTs) / tsRange) * chartW : 0
  const hoverY = hoverPoint ? padTop + (1 - (hoverPoint[1] - yMin) / yRange) * chartH : 0
  const tipW = 46
  const tipH = 22
  const tipX = hoverPoint
    ? Math.min(Math.max(hoverX - tipW / 2, padLeft), width - padRight - tipW)
    : 0
  const tipAbove = hoverPoint ? hoverY - 6 - tipH >= padTop : true
  const tipY = hoverPoint ? (tipAbove ? hoverY - 6 - tipH : hoverY + 6) : 0

  function handleMove(e: MouseEvent<SVGRectElement>) {
    if (data.length === 0) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0) return
    // Map mouse client X to viewBox x, then to a timestamp, then snap to nearest point.
    const xVb = ((e.clientX - rect.left) / rect.width) * width
    const ts = minTs + ((xVb - padLeft) / chartW) * tsRange
    let idx = 0
    let best = Infinity
    for (let i = 0; i < data.length; i++) {
      const diff = Math.abs(data[i][0] - ts)
      if (diff < best) {
        best = diff
        idx = i
      }
    }
    setHover(idx)
  }

  return (
    <div style={{ minWidth: 0 }}>
      <div className="mb-1 flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-xs font-medium text-[#555]">{label}</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height: '96px' }}
      >
        {yTicks.map(tick => {
          const y = padTop + (1 - (tick - yMin) / yRange) * chartH
          return (
            <g key={tick}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="#f0f0f0"
                strokeWidth="0.5"
              />
              <text x={padLeft - 5} y={y + 3} textAnchor="end" fontSize="9" fill="#c6c8cc">
                {Math.round(tick)}
              </text>
            </g>
          )
        })}
        {area && <path d={area} fill={color} opacity="0.06" />}
        {path && (
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth="1.8"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {timeLabels.map(({ ts, x }) => (
          <text key={ts} x={x} y={height - 5} textAnchor="middle" fontSize="10" fill="#a8adb4">
            {fmt(ts)}
          </text>
        ))}
        {hoverPoint && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              y1={padTop}
              x2={hoverX}
              y2={padTop + chartH}
              stroke="#c6c8cc"
              strokeWidth="0.5"
              strokeDasharray="2 2"
            />
            <circle cx={hoverX} cy={hoverY} r="2.5" fill={color} stroke="#fff" strokeWidth="0.8" />
            <rect
              x={tipX}
              y={tipY}
              width={tipW}
              height={tipH}
              rx="3"
              fill="#fff"
              stroke="#e5e7eb"
              strokeWidth="0.5"
            />
            <text x={tipX + tipW / 2} y={tipY + 9} textAnchor="middle" fontSize="8" fill="#6b6f76">
              {fmt(hoverPoint[0])}
            </text>
            <text
              x={tipX + tipW / 2}
              y={tipY + 18}
              textAnchor="middle"
              fontSize="9"
              fontWeight="600"
              fill="#3c4043"
            >
              {formatPercent(hoverPoint[1])}%
            </text>
          </g>
        )}
        {/* Transparent overlay captures mouse events for the whole plot area. */}
        <rect
          x={padLeft}
          y={padTop}
          width={chartW}
          height={chartH}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
    </div>
  )
}

function MetricsChart({
  history,
  labels,
}: {
  history: MetricsHistoryResponse
  labels: Record<string, string>
}) {
  const metrics = [
    { key: 'cpu' as const, label: labels.cpu, data: history.cpu },
    { key: 'memory' as const, label: labels.memory, data: history.memory },
    { key: 'disk' as const, label: labels.disk, data: history.disk },
  ]

  const allData = metrics.flatMap(m => m.data)
  if (allData.length === 0) {
    return (
      <div className="flex h-[136px] items-center justify-center rounded-md border border-[#eeeeee] bg-[#fbfbfb] text-xs text-[#bbb]">
        {labels.no_data}
      </div>
    )
  }

  const allTs = allData.map(d => d[0])
  const minTs = Math.min(...allTs)
  const maxTs = Math.max(...allTs)
  const tsRange = maxTs - minTs || 1

  return (
    <div
      data-testid="device-metrics-chart-grid"
      className="rounded-md border border-[#eeeeee] bg-[#fbfbfb]"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: '16px',
        padding: '12px 16px',
      }}
    >
      {metrics.map(m => (
        <SingleMetricChart
          key={m.key}
          label={m.label}
          color={CHART_COLORS[m.key]}
          data={m.data}
          minTs={minTs}
          tsRange={tsRange}
        />
      ))}
    </div>
  )
}

export function DeviceMetrics({ deviceId }: DeviceMetricsProps) {
  const { t } = useTranslation('wecode')
  const [metrics, setMetrics] = useState<CloudDeviceMetricsResponse | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [history, setHistory] = useState<MetricsHistoryResponse | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const labels = {
    cpu: t('cloud_device.metrics.cpu'),
    memory: t('cloud_device.metrics.memory'),
    disk: t('cloud_device.metrics.disk'),
    loading: t('cloud_device.metrics.loading'),
    no_data: t('cloud_device.metrics.no_data'),
    alert_title: t('cloud_device.metrics.alert_title'),
    alert_desc: t('cloud_device.metrics.alert_desc'),
    alert_link: t('cloud_device.metrics.alert_link'),
  }

  const isHighUsage =
    !!metrics &&
    [metrics.cpu_usage, metrics.memory_usage, metrics.disk_usage].some(
      v => v != null && v >= HIGH_USAGE_THRESHOLD
    )

  const fetchMetrics = useCallback(async () => {
    try {
      const data = await cloudDeviceApis.getMetrics(deviceId)
      setMetrics(data)
    } catch (error) {
      console.warn(`[DeviceMetrics] Failed to fetch metrics for ${deviceId}:`, error)
    }
  }, [deviceId])

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const data = await cloudDeviceApis.getMetricsHistory(deviceId)
      setHistory(data)
    } catch (error) {
      console.warn(`[DeviceMetrics] Failed to fetch metrics history for ${deviceId}:`, error)
    } finally {
      setHistoryLoading(false)
    }
  }, [deviceId])

  useEffect(() => {
    void Promise.resolve().then(fetchMetrics)
    timerRef.current = setInterval(fetchMetrics, REFRESH_INTERVAL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [fetchMetrics])

  const handleToggle = () => {
    const next = !expanded
    setExpanded(next)
    // Re-fetch on every expand so the trend chart does not go stale while the
    // panel is open (real-time metrics refresh on their own 30s interval).
    if (next) {
      fetchHistory()
    }
  }

  return (
    <div data-testid={`device-metrics-${deviceId}`} className="mt-2">
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleToggle()
          }
        }}
        className="flex w-full cursor-pointer items-center gap-5 rounded-md px-0.5 py-1 transition-colors hover:bg-[#fafafa]"
      >
        <ResourceMetric icon={Cpu} label={labels.cpu} value={metrics?.cpu_usage ?? null} />
        <ResourceMetric
          icon={MemoryStick}
          label={labels.memory}
          value={metrics?.memory_usage ?? null}
        />
        <div className="flex items-center gap-1">
          <ResourceMetric
            icon={HardDrive}
            label={labels.disk}
            value={metrics?.disk_usage ?? null}
          />
          {isHighUsage && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid={`device-metrics-alert-${deviceId}`}
                  aria-label={labels.alert_title}
                  onClick={e => e.stopPropagation()}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-amber-500 transition-colors hover:bg-amber-50"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-72" align="start">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="text-sm font-medium text-text-primary">
                      {labels.alert_title}
                    </span>
                  </div>
                  <p className="text-xs leading-5 text-text-secondary">{labels.alert_desc}</p>
                  <a
                    href={SCALING_WIKI_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    {labels.alert_link}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 text-[#ccc] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </div>

      {expanded && (
        <div className="mt-2 pb-0.5">
          {historyLoading && !history ? (
            <div className="flex h-[136px] items-center justify-center rounded-md border border-[#eeeeee] bg-[#fbfbfb] text-xs text-[#999]">
              {labels.loading}
            </div>
          ) : history ? (
            <MetricsChart history={history} labels={labels} />
          ) : (
            <div className="flex h-[136px] items-center justify-center rounded-md border border-[#eeeeee] bg-[#fbfbfb] text-xs text-[#999]">
              {labels.no_data}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
