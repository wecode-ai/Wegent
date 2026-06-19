import {
  isDeviceUpgradeRequiredForWeWork,
  isWeWorkCompatibleDevice,
} from './device-capabilities'

export interface SelectableDevice {
  device_id: string
  name?: string | null
  status?: string | null
  device_type?: string | null
  bind_shell?: string | null
  executor_version?: string | null
  direct_chat?: { enabled?: boolean } | null
}

export function isClaudeCodeDevice(device: SelectableDevice): boolean {
  return (device.bind_shell ?? 'claudecode').toLowerCase() === 'claudecode'
}

export function isOnlineDevice(device: SelectableDevice): boolean {
  return device.status === 'online'
}

export function isCloudDevice(device: SelectableDevice): boolean {
  return device.device_type === 'cloud'
}

export function isWeWorkSelectableStandaloneDevice(device: SelectableDevice): boolean {
  return isOnlineDevice(device) && isWeWorkCompatibleDevice(device)
}

export function sortStandaloneDevices<T extends SelectableDevice>(devices: T[]): T[] {
  return devices.filter(isClaudeCodeDevice).sort((left, right) => {
    const leftOnline = isOnlineDevice(left) ? 0 : 1
    const rightOnline = isOnlineDevice(right) ? 0 : 1
    if (leftOnline !== rightOnline) return leftOnline - rightOnline

    const leftCompatible = isDeviceUpgradeRequiredForWeWork(left) ? 1 : 0
    const rightCompatible = isDeviceUpgradeRequiredForWeWork(right) ? 1 : 0
    if (leftCompatible !== rightCompatible) return leftCompatible - rightCompatible

    const leftCloud = isOnlineDevice(left) && isCloudDevice(left) ? 0 : 1
    const rightCloud = isOnlineDevice(right) && isCloudDevice(right) ? 0 : 1
    if (leftCloud !== rightCloud) return leftCloud - rightCloud

    return (left.name || left.device_id).localeCompare(right.name || right.device_id)
  })
}

export function getPreferredStandaloneDeviceId(
  devices: SelectableDevice[],
  currentDeviceId?: string | null,
): string | null {
  const currentDevice = currentDeviceId
    ? devices.find(device => device.device_id === currentDeviceId)
    : undefined

  if (currentDevice && isWeWorkSelectableStandaloneDevice(currentDevice)) {
    return currentDevice.device_id
  }

  return sortStandaloneDevices(devices).find(isWeWorkSelectableStandaloneDevice)?.device_id ?? null
}
