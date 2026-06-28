import type { DeviceInfo } from '@/types/api'

type AppDeviceLike = Pick<DeviceInfo, 'device_id' | 'device_type' | 'app_device_id'>

function normalizeDeviceId(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed || null
}

function currentAppDeviceIdSet(deviceIds: Iterable<string | null | undefined>): Set<string> {
  const ids = new Set<string>()
  for (const value of deviceIds) {
    const deviceId = normalizeDeviceId(value)
    if (deviceId) ids.add(deviceId)
  }
  return ids
}

export function isAppDeviceRegistration(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return device.device_type === 'app'
}

export function isCurrentAppDeviceId(
  deviceId: string | null | undefined,
  appDeviceIds: Iterable<string | null | undefined>
): boolean {
  const normalizedDeviceId = normalizeDeviceId(deviceId)
  if (!normalizedDeviceId) return false
  return currentAppDeviceIdSet(appDeviceIds).has(normalizedDeviceId)
}

export function isCurrentAppDevice(
  device: AppDeviceLike,
  appDeviceIds: Iterable<string | null | undefined>
): boolean {
  const ids = currentAppDeviceIdSet(appDeviceIds)
  if (ids.size === 0) return false
  return [device.device_id, device.app_device_id].some(value => {
    const deviceId = normalizeDeviceId(value)
    return Boolean(deviceId && ids.has(deviceId))
  })
}
