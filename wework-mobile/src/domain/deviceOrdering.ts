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

export function mobileOperableDevices(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return devices.filter(
    device =>
      (device.device_type === 'cloud' || device.device_type === 'remote') &&
      device.bind_shell === 'claudecode'
  )
}

export function selectedOnlineDeviceId(
  devices: readonly DeviceInfo[],
  preferredDeviceId: string | null
): string | null {
  const preferred = devices.find(
    device => device.device_id === preferredDeviceId && device.status !== 'offline'
  )
  return (
    preferred?.device_id ?? devices.find(device => device.status !== 'offline')?.device_id ?? null
  )
}
