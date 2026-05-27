import { Cpu, HardDrive, MemoryStick } from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cloudDeviceInternalApis } from '@wecode/api/devices'
import type { CloudDeviceMetricsResponse } from '@wecode/types/devices'

const REFRESH_INTERVAL_MS = 30_000

interface DeviceMetricsProps {
  deviceId: string
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
  const displayValue = value !== null ? Math.round(value) : '--'

  return (
    <div className="flex min-w-[150px] items-center gap-2 text-xs text-[#6b6f76]">
      <span className="inline-flex w-12 shrink-0 items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#e8eaed]">
        <div
          className="h-full rounded-full bg-[#3c4043]"
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right font-medium text-[#3c4043]">
        {displayValue}%
      </span>
    </div>
  )
}

export function DeviceMetrics({ deviceId }: DeviceMetricsProps) {
  const [metrics, setMetrics] = useState<CloudDeviceMetricsResponse | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchMetrics = useCallback(async () => {
    try {
      const data = await cloudDeviceInternalApis.getMetrics(deviceId)
      setMetrics(data)
    } catch {
      // silently ignore fetch errors
    }
  }, [deviceId])

  useEffect(() => {
    fetchMetrics()
    timerRef.current = setInterval(fetchMetrics, REFRESH_INTERVAL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [fetchMetrics])

  return (
    <div
      data-testid={`device-metrics-${deviceId}`}
      className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md bg-[#fafafa] px-3 py-2"
    >
      <ResourceMetric icon={Cpu} label="CPU" value={metrics?.cpu_usage ?? null} />
      <ResourceMetric icon={MemoryStick} label="MEM" value={metrics?.memory_usage ?? null} />
      <ResourceMetric icon={HardDrive} label="磁盘" value={metrics?.disk_usage ?? null} />
    </div>
  )
}
