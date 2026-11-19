import type { DeviceInfo } from '@/types/api'
import { isUsableDevice } from '@/lib/device-capabilities'

export function eligibleCloudAutomationDevices(devices: readonly DeviceInfo[]) {
  return devices.filter(device => isUsableDevice(device) && device.device_type !== 'app')
}

export function cloudAutomationTargetsKey(devices: readonly DeviceInfo[]): string {
  return JSON.stringify(
    Array.from(
      new Set(eligibleCloudAutomationDevices(devices).map(device => device.device_id))
    ).sort()
  )
}
