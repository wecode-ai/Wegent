import { ChevronDown, Cpu, HardDrive, MemoryStick } from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cloudDeviceInternalApis } from '@wecode/api/devices'
import type { CloudDeviceMetricsResponse, MetricsHistoryResponse } from '@wecode/types/devices'

const REFRESH_INTERVAL_MS = 30_000

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
  const range = dataMax - dataMin
  const yMin = Math.max(0, dataMin - range * 0.2)
  const yMax = Math.min(100, dataMax + range * 0.3)
  const yRange = yMax - yMin || 1

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

  return (
    <div style={{ minWidth: 0 }}>
      <div className="mb-1 flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-xs font-medium text-[#555]">{label}</span>
      </div>
      <svg
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
        {area && (
          <path d={area} fill={color} opacity="0.06" />
        )}
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
      </svg>
    </div>
  )
}

function MetricsChart({ history }: { history: MetricsHistoryResponse }) {
  const metrics = [
    { key: 'cpu' as const, label: 'CPU', data: history.cpu },
    { key: 'memory' as const, label: 'MEM', data: history.memory },
    { key: 'disk' as const, label: '磁盘', data: history.disk },
  ]

  const allData = metrics.flatMap(m => m.data)
  if (allData.length === 0) {
    return (
      <div className="flex h-[136px] items-center justify-center rounded-md border border-[#eeeeee] bg-[#fbfbfb] text-xs text-[#bbb]">
        暂无数据
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
  const [metrics, setMetrics] = useState<CloudDeviceMetricsResponse | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [history, setHistory] = useState<MetricsHistoryResponse | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchMetrics = useCallback(async () => {
    try {
      const data = await cloudDeviceInternalApis.getMetrics(deviceId)
      setMetrics(data)
    } catch {
      // silently ignore
    }
  }, [deviceId])

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const data = await cloudDeviceInternalApis.getMetricsHistory(deviceId)
      setHistory(data)
    } catch {
      // silently ignore
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
    if (next && !history) {
      fetchHistory()
    }
  }

  return (
    <div data-testid={`device-metrics-${deviceId}`} className="mt-2">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-5 rounded-md px-0.5 py-1 transition-colors hover:bg-[#fafafa]"
      >
        <ResourceMetric icon={Cpu} label="CPU" value={metrics?.cpu_usage ?? null} />
        <ResourceMetric icon={MemoryStick} label="MEM" value={metrics?.memory_usage ?? null} />
        <ResourceMetric icon={HardDrive} label="磁盘" value={metrics?.disk_usage ?? null} />
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 text-[#ccc] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="mt-2 pb-0.5">
          {historyLoading ? (
            <div className="flex h-[136px] items-center justify-center rounded-md border border-[#eeeeee] bg-[#fbfbfb] text-xs text-[#999]">
              加载中...
            </div>
          ) : history ? (
            <MetricsChart history={history} />
          ) : (
            <div className="flex h-[136px] items-center justify-center rounded-md border border-[#eeeeee] bg-[#fbfbfb] text-xs text-[#999]">
              暂无数据
            </div>
          )}
        </div>
      )}
    </div>
  )
}
