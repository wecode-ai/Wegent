import type { DeviceInfo } from '@/types/runtime'

export function onlineDevicesFirst(devices: readonly DeviceInfo[]): DeviceInfo[] {
  const online: DeviceInfo[] = []
  const offline: DeviceInfo[] = []
  for (const device of devices) {
    if (device.status === 'offline') offline.push(device)
    else online.push(device)
  }
  return [...online, ...offline]
}
