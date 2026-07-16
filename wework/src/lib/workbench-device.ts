import type { DeviceInfo, ProjectWithTasks } from '@/types/api'

/** Logical alias used by CLI open and local IPC routing before the real executor id is known. */
export const LOCAL_WORKBENCH_DEVICE_ALIAS = 'local-device'

export function getProjectDeviceId(project: ProjectWithTasks | null | undefined) {
  return project?.config?.execution?.deviceId ?? project?.config?.device_id
}

export function getActiveWorkbenchDeviceId({
  currentProject,
  standaloneDeviceId,
}: {
  currentProject: ProjectWithTasks | null
  standaloneDeviceId?: string | null
}) {
  const projectDeviceId = getProjectDeviceId(currentProject)
  return projectDeviceId ?? (!currentProject ? (standaloneDeviceId ?? undefined) : undefined)
}

export function isLocalWorkbenchDeviceAlias(deviceId: string | null | undefined): boolean {
  return deviceId?.trim() === LOCAL_WORKBENCH_DEVICE_ALIAS
}

/**
 * Resolve a device id for UI/state use. The CLI open path always starts with the
 * `local-device` alias, but the local executor reports a concrete device id such as
 * `device-...`. Matching that concrete id is required for online checks and send.
 */
export function resolveLocalWorkbenchDeviceId(
  devices: DeviceInfo[],
  deviceId: string | null | undefined
): string | null {
  const normalized = deviceId?.trim()
  if (!normalized) return null

  if (devices.some(device => device.device_id === normalized)) {
    return normalized
  }

  if (!isLocalWorkbenchDeviceAlias(normalized)) {
    return normalized
  }

  const localDevices = devices.filter(device => device.device_type === 'local')
  const onlineLocal =
    localDevices.find(device => device.status === 'online' || device.status === 'busy') ??
    localDevices[0]
  if (onlineLocal) return onlineLocal.device_id

  const defaultDevice = devices.find(device => device.is_default)
  return defaultDevice?.device_id ?? normalized
}

export function findWorkbenchDevice(devices: DeviceInfo[], deviceId: string | null | undefined) {
  if (!deviceId) return null

  const exact = devices.find(device => device.device_id === deviceId) ?? null
  if (exact) return exact

  const aliased = devices.find(device => workbenchDeviceMatchesId(device, deviceId)) ?? null
  if (aliased) return aliased

  if (!isLocalWorkbenchDeviceAlias(deviceId)) return null

  const resolvedId = resolveLocalWorkbenchDeviceId(devices, deviceId)
  if (!resolvedId || resolvedId === deviceId) return null
  return devices.find(device => device.device_id === resolvedId) ?? null
}

export function isWorkbenchDeviceOnline(device: DeviceInfo | null) {
  return Boolean(device && device.status === 'online')
}

export function getWorkbenchDeviceDisplayName(
  device: DeviceInfo | null,
  deviceId: string | null | undefined
) {
  return device?.name || deviceId || ''
}

export function workbenchDeviceMatchesId(device: DeviceInfo, deviceId: string): boolean {
  const normalizedDeviceId = deviceId.trim()
  if (!normalizedDeviceId) return false

  const ids = [
    device.device_id,
    device.app_device_id,
    device.socket_device_id,
    device.runtime_instance_id,
    ...(device.runtime_routes?.flatMap(route => [route.device_id, route.runtime_device_id]) ?? []),
  ]
  return ids.some(id => id?.trim() === normalizedDeviceId)
}

function extractNetworkHost(value?: string | null): string | null {
  const normalized = value?.trim()
  if (!normalized) return null

  const bracketMatch = normalized.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]

  const colonParts = normalized.split(':')
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return colonParts[0] || null
  }
  return normalized
}

export function getWorkbenchDeviceUnavailableDisplayName(device: DeviceInfo | null): string {
  return (
    extractNetworkHost(device?.client_ip) ?? extractNetworkHost(device?.runtime_transfer_host) ?? ''
  )
}

export function getExecutorOfflineDeviceId(error?: string | null): string | null {
  const prefix = 'executor-offline:'
  if (!error?.startsWith(prefix)) return null
  const deviceId = error.slice(prefix.length).trim()
  return deviceId || null
}
