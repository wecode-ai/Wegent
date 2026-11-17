import { useEffect, useRef } from 'react'
import { findWorkbenchDevice, isWorkbenchDeviceOnline } from '@/lib/workbench-device'
import type { DeviceInfo } from '@/types/api'

/** Refresh device-owned reads when this owner becomes reachable again. */
export function useWorkbenchDeviceReconnect({
  deviceId,
  devices,
  onReconnect,
}: {
  deviceId: string | undefined
  devices: DeviceInfo[] | undefined
  onReconnect: () => void
}) {
  const online = isWorkbenchDeviceOnline(
    devices && deviceId ? findWorkbenchDevice(devices, deviceId) : null
  )
  const previous = useRef({ deviceId, online })
  useEffect(() => {
    const before = previous.current
    previous.current = { deviceId, online }
    if (deviceId && before.deviceId === deviceId && !before.online && online) onReconnect()
  }, [deviceId, online, onReconnect])
}
