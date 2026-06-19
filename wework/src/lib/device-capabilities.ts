import type { DeviceInfo } from '@/types/api'

type DeviceLike = {
  device_type?: DeviceInfo['device_type'] | string | null
  bind_shell?: DeviceInfo['bind_shell'] | string | null
  status?: DeviceInfo['status'] | string | null
  direct_chat?: { enabled?: boolean | null } | null
  executor_version?: string | null
  update_available?: boolean
  slot_used?: number
  running_tasks?: DeviceInfo['running_tasks']
  running_task_ids?: number[]
}

export function isClaudeCodeDevice(device: DeviceLike): boolean {
  return (device.bind_shell ?? 'claudecode').toLowerCase() === 'claudecode'
}

export function isCloudDevice(device: { device_type?: string | null }): boolean {
  return device.device_type === 'cloud'
}

export function isUsableDevice(device: { status?: string | null }): boolean {
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

export function isDeviceUpgradeRequiredForWeWork(device: DeviceLike): boolean {
  return isClaudeCodeDevice(device) && device.direct_chat?.enabled !== true
}

export function isWeWorkCompatibleDevice(device: DeviceLike): boolean {
  return isClaudeCodeDevice(device) && !isDeviceUpgradeRequiredForWeWork(device)
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
    !isDeviceUpgradeRequiredForWeWork(device)
  )
}

export function supportsCloudSessions(device: DeviceLike): boolean {
  return isCloudDevice(device) && isClaudeCodeDevice(device)
}

export function supportsRemoteTerminalSessions(device: DeviceLike): boolean {
  return isClaudeCodeDevice(device)
}

export function supportsLocalTerminalLaunch(device: DeviceLike): boolean {
  return !isCloudDevice(device) && isClaudeCodeDevice(device)
}

export function supportsDeviceMetrics(device: { device_type?: string | null }): boolean {
  return isCloudDevice(device)
}

export function supportsCloudLifecycleActions(device: { device_type?: string | null }): boolean {
  return isCloudDevice(device)
}
