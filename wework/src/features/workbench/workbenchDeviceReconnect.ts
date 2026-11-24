import { findWorkbenchDevice, isWorkbenchDeviceOnline } from '@/lib/workbench-device'
import type { DeviceInfo } from '@/types/api'

interface DeviceReconnectInput {
  deviceId: string | undefined
  devices: DeviceInfo[] | undefined
  onReconnect: () => void
}

/** A committed device owner retries its reads only after an offline-to-online transition. */
export function createWorkbenchDeviceReconnect() {
  let previous: { deviceId: string | undefined; online: boolean } | undefined
  return {
    update({ deviceId, devices, onReconnect }: DeviceReconnectInput) {
      const online = isWorkbenchDeviceOnline(
        devices && deviceId ? findWorkbenchDevice(devices, deviceId) : null
      )
      const before = previous
      previous = { deviceId, online }
      if (deviceId && before?.deviceId === deviceId && !before.online && online) onReconnect()
    },
  }
}
