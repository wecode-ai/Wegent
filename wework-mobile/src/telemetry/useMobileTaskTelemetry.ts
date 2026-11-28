import { useEffect, useRef } from 'react'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/runtime'
import { mobileTelemetry } from './mobileTelemetry'
import { MobileTaskTelemetryObserver } from './mobileTaskTelemetryObserver'

export function useMobileTaskTelemetry({
  work,
  taskRunningByKey,
  devices,
}: {
  work: RuntimeWorkListResponse
  taskRunningByKey: ReadonlyMap<string, boolean>
  devices: DeviceInfo[]
}): void {
  const observer = useRef<MobileTaskTelemetryObserver | null>(null)
  observer.current ??= new MobileTaskTelemetryObserver(mobileTelemetry.track.bind(mobileTelemetry))

  useEffect(() => {
    observer.current?.observe({ work, taskRunningByKey, devices })
  }, [devices, taskRunningByKey, work])
}
