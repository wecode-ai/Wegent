import {
  AmbiguousExecutorIdentityError,
  createWorkbenchDeviceResolver,
  getWorkbenchDeviceIds,
  mergeDeviceLists,
  type WorkbenchDeviceResolver as SharedWorkbenchDeviceResolver,
} from '@wegent/chat-core/runtime-device-identity'
import { getLocalRuntimeSourceIdentity } from './local-runtime-sidebar-identity'
import type { DeviceInfo, ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'

export {
  AmbiguousExecutorIdentityError,
  createWorkbenchDeviceResolver,
  getWorkbenchDeviceIds,
  mergeDeviceLists,
  workbenchDevicesShareRuntimeIdentity,
} from '@wegent/chat-core/runtime-device-identity'
export type WorkbenchDeviceResolver = SharedWorkbenchDeviceResolver<DeviceInfo>

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

/** Resolve the current native IPC address only when its source proves the runtime. */
export function findNativeLocalWorkbenchDevice(
  devices: DeviceInfo[],
  deviceId: string | null | undefined
) {
  if (!deviceId) return null

  const normalized = deviceId.trim()
  const nativeLocalDevices = devices.filter(device => {
    const identity = getLocalRuntimeSourceIdentity(device)
    return (
      device.device_type === 'local' &&
      identity?.provenance === 'local-ipc' &&
      identity.deviceId === normalized &&
      device.device_id === identity.deviceId &&
      Boolean(identity.runtimeInstanceId) &&
      device.runtime_instance_id === identity.runtimeInstanceId
    )
  })
  return nativeLocalDevices.length === 1 ? nativeLocalDevices[0] : null
}

export function findWorkbenchDevice(devices: DeviceInfo[], deviceId: string | null | undefined) {
  if (!deviceId) return null

  let resolved: DeviceInfo | null
  try {
    resolved = createWorkbenchDeviceResolver(devices).resolve(deviceId.trim())
  } catch (error) {
    // Ambiguous addresses are unavailable in the UI; writes keep the strict resolver.
    if (error instanceof AmbiguousExecutorIdentityError) return null
    throw error
  }
  if (resolved) return resolved

  if (!isLocalWorkbenchDeviceAlias(deviceId)) return null

  const resolvedId = resolveLocalWorkbenchDeviceId(devices, deviceId)
  if (!resolvedId || resolvedId === deviceId) return null
  return devices.find(device => device.device_id === resolvedId) ?? null
}

export function resolveWorkbenchDeviceId(
  devices: DeviceInfo[],
  deviceId: string | null | undefined
): string | null {
  const normalized = deviceId?.trim()
  if (!normalized) return null
  return findWorkbenchDevice(devices, normalized)?.device_id ?? normalized
}

export function isWorkbenchDeviceOnline(device: DeviceInfo | null) {
  return Boolean(device && (device.status === 'online' || device.status === 'busy'))
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

  return getWorkbenchDeviceIds(device).includes(normalizedDeviceId)
}

export function getUnambiguousWorkbenchDeviceAliases(devices: DeviceInfo[]): Map<string, string> {
  const candidates = new Map<string, Set<string>>()
  for (const device of mergeDeviceLists(devices, [])) {
    const canonicalDeviceId = device.device_id.trim()
    if (!canonicalDeviceId) continue
    for (const alias of getWorkbenchDeviceIds(device)) {
      const matches = candidates.get(alias) ?? new Set<string>()
      matches.add(canonicalDeviceId)
      candidates.set(alias, matches)
    }
  }
  return new Map(
    [...candidates].map(([alias, matches]) => [alias, matches.size === 1 ? [...matches][0] : alias])
  )
}

export function getWorkbenchDeviceNamesById(
  devices: DeviceInfo[]
): Readonly<Record<string, string>> {
  const names: Record<string, string> = {}
  for (const device of devices) {
    const name = device.name.trim()
    if (!name) continue
    for (const deviceId of getWorkbenchDeviceIds(device)) names[deviceId] = name
  }
  return names
}

export function getRuntimeWorkDeviceNamesById(
  runtimeWork: RuntimeWorkListResponse | null | undefined
): Readonly<Record<string, string>> {
  const names: Record<string, string> = {}
  const workspaces = [
    ...(runtimeWork?.projects ?? []).flatMap(item => item.deviceWorkspaces),
    ...(runtimeWork?.chats ?? []),
  ]
  for (const workspace of workspaces) {
    const name = workspace.deviceName?.trim()
    if (name) names[workspace.deviceId] = name
  }
  return names
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
