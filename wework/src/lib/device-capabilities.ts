import type { DeviceInfo } from '@/types/api'

type DeviceLike = Pick<DeviceInfo, 'device_type' | 'bind_shell' | 'status'>

export function isClaudeCodeDevice(device: DeviceLike): boolean {
  return (device.bind_shell ?? 'claudecode') === 'claudecode'
}

export function isCloudDevice(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return device.device_type === 'cloud'
}

export function isUsableDevice(device: Pick<DeviceInfo, 'status'>): boolean {
  return device.status === 'online' || device.status === 'busy'
}

export function canUseForProjectCreation(device: DeviceLike): boolean {
  return isClaudeCodeDevice(device) && isUsableDevice(device)
}

export function supportsCloudSessions(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return isCloudDevice(device)
}

export function supportsDeviceMetrics(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return isCloudDevice(device)
}

export function supportsCloudLifecycleActions(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return isCloudDevice(device)
}
