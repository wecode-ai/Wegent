import type { DeviceInfo } from '@/types/api'
import { isCloudDevice, isRemoteDevice, isUsableDevice } from '@/lib/device-capabilities'

export function availableStandInDevices(devices: DeviceInfo[]) {
  return devices.filter(
    device => (isCloudDevice(device) || isRemoteDevice(device)) && isUsableDevice(device)
  )
}
