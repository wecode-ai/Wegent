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
  return devices
    .filter(
      device =>
        (device.device_type === 'cloud' ||
          device.device_type === 'remote' ||
          (device.device_type === 'app' &&
            Boolean(device.execution_target_id) &&
            device.runtime_features?.remoteTaskAccess?.version === 1 &&
            device.runtime_features.remoteTaskAccess.enabled === true)) &&
        device.bind_shell === 'claudecode'
    )
    .map(device =>
      device.device_type === 'app' ? { ...device, device_id: device.execution_target_id! } : device
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

export function mobileCreatableDevices(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return mobileOperableDevices(devices).filter(
    device =>
      device.status !== 'offline' &&
      (device.device_type !== 'app' ||
        device.runtime_features?.remoteTaskAccess?.taskCreation === true)
  )
}

export function mobileProjectCreatableDevices(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return mobileCreatableDevices(devices).filter(device => device.device_type !== 'app')
}
