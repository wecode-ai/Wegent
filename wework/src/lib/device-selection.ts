export interface SelectableDevice {
  device_id: string
  name?: string | null
  status?: string | null
  device_type?: string | null
}

export function isOnlineDevice(device: SelectableDevice): boolean {
  return device.status === 'online'
}

export function isCloudDevice(device: SelectableDevice): boolean {
  return device.device_type === 'cloud'
}

export function sortStandaloneDevices<T extends SelectableDevice>(devices: T[]): T[] {
  return [...devices].sort((left, right) => {
    const leftOnline = isOnlineDevice(left) ? 0 : 1
    const rightOnline = isOnlineDevice(right) ? 0 : 1
    if (leftOnline !== rightOnline) return leftOnline - rightOnline

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

  if (currentDevice && isOnlineDevice(currentDevice)) {
    return currentDevice.device_id
  }

  return sortStandaloneDevices(devices).find(isOnlineDevice)?.device_id ?? null
}
