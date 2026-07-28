import type { DeviceInfo } from '@/types/api'

export const WEWORK_MIN_EXECUTOR_VERSION = '1.8.5'

type DeviceLike = Pick<DeviceInfo, 'device_type' | 'bind_shell' | 'status'> &
  Partial<
    Pick<
      DeviceInfo,
      | 'executor_version'
      | 'update_available'
      | 'slot_used'
      | 'running_tasks'
      | 'running_task_ids'
      | 'runtime_routes'
    >
  >

export function isVersionAtLeast(version: string, targetVersion: string): boolean {
  const parseVersion = (value: string): number[] | null => {
    const baseVersion = value.trim().replace(/^v/i, '').split('-')[0]
    const parts = baseVersion.split('.').map(Number)
    if (parts.length === 0 || parts.some(Number.isNaN)) return null
    return parts
  }

  const current = parseVersion(version)
  const target = parseVersion(targetVersion)
  if (!current || !target) return false

  for (let index = 0; index < Math.max(current.length, target.length); index += 1) {
    const currentPart = current[index] ?? 0
    const targetPart = target[index] ?? 0
    if (currentPart > targetPart) return true
    if (currentPart < targetPart) return false
  }

  return true
}

export function isClaudeCodeDevice(device: DeviceLike): boolean {
  return (device.bind_shell ?? 'claudecode').toLowerCase() === 'claudecode'
}

export function filterClaudeCodeDevices<T extends DeviceLike>(devices: T[]): T[] {
  return devices.filter(isClaudeCodeDevice)
}

export function isCloudDevice(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return device.device_type === 'cloud'
}

export function isRemoteDevice(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return device.device_type === 'remote'
}

export function isAppDevice(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return device.device_type === 'app'
}

export function isUsableDevice(device: Pick<DeviceInfo, 'status'>): boolean {
  return device.status === 'online' || device.status === 'busy'
}

export function isOnlineIdleDevice(device: DeviceLike): boolean {
  return device.status === 'online' && !isDeviceRunningTask(device)
}

export function isDeviceRunningTask(device: DeviceLike): boolean {
  return (
    (device.slot_used ?? 0) > 0 ||
    (device.running_tasks?.length ?? 0) > 0 ||
    (device.running_task_ids?.length ?? 0) > 0
  )
}

export function isWeWorkExecutorVersionCompatible(version?: string | null): boolean {
  if (!version) return false
  return isVersionAtLeast(version, WEWORK_MIN_EXECUTOR_VERSION)
}

export function isDeviceBelowWeWorkVersion(device: DeviceLike): boolean {
  return !isWeWorkExecutorVersionCompatible(device.executor_version)
}

export function isWeWorkCompatibleDevice(device: DeviceLike): boolean {
  return isClaudeCodeDevice(device) && isWeWorkExecutorVersionCompatible(device.executor_version)
}

export function hasWeWorkUpdateAvailable(device: DeviceLike): boolean {
  return isClaudeCodeDevice(device) && device.update_available === true
}

export function canRequestDeviceUpgrade(device: DeviceLike): boolean {
  return isClaudeCodeDevice(device) && isOnlineIdleDevice(device)
}

export function canUseForProjectCreation(device: DeviceLike): boolean {
  return (
    isClaudeCodeDevice(device) &&
    isUsableDevice(device) &&
    isWeWorkExecutorVersionCompatible(device.executor_version)
  )
}

export function hasLocalRuntimeRoute(device: DeviceLike): boolean {
  if (!isCloudDevice(device) && !isRemoteDevice(device)) return true
  return Boolean(
    device.runtime_routes?.some(route => route.kind === 'local-ipc' || route.kind === 'app-ipc')
  )
}

export function canUseForRemoteProjectCreation(device: DeviceLike): boolean {
  return (
    (isCloudDevice(device) || isRemoteDevice(device)) &&
    !hasLocalRuntimeRoute(device) &&
    canUseForProjectCreation(device)
  )
}

function selectedRuntimeRouteKind(device: DeviceLike, deviceId?: string | null) {
  const normalizedDeviceId = deviceId?.trim()
  if (!normalizedDeviceId) return null

  return (
    device.runtime_routes?.find(
      route =>
        route.device_id.trim() === normalizedDeviceId ||
        route.runtime_device_id.trim() === normalizedDeviceId
    )?.kind ?? null
  )
}

export function supportsCloudSessions(device: DeviceLike, deviceId?: string | null): boolean {
  if (!isClaudeCodeDevice(device)) return false
  const routeKind = selectedRuntimeRouteKind(device, deviceId)
  return routeKind ? routeKind === 'cloud-relay' : isCloudDevice(device)
}

export function supportsRemoteSessions(device: DeviceLike, deviceId?: string | null): boolean {
  if (!isClaudeCodeDevice(device)) return false
  const routeKind = selectedRuntimeRouteKind(device, deviceId)
  return routeKind ? routeKind === 'remote-relay' : isRemoteDevice(device)
}

export function supportsRemoteTerminalSessions(
  device: DeviceLike,
  deviceId?: string | null
): boolean {
  if (!isClaudeCodeDevice(device)) return false
  const routeKind = selectedRuntimeRouteKind(device, deviceId)
  return routeKind
    ? routeKind === 'cloud-relay' || routeKind === 'remote-relay'
    : isCloudDevice(device) || isRemoteDevice(device)
}

export function supportsLocalTerminalLaunch(device: DeviceLike): boolean {
  return !isCloudDevice(device) && !isRemoteDevice(device) && isClaudeCodeDevice(device)
}

export function supportsDeviceMetrics(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return isCloudDevice(device)
}

export function supportsCloudLifecycleActions(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return isCloudDevice(device)
}
