import { isAppDevice, isCloudDevice, isRemoteDevice } from './device-capabilities'
import { getLocalRuntimeSourceIdentity } from './local-runtime-sidebar-identity'
import type {
  DeviceInfo,
  DeviceRuntimeRoute,
  DeviceRuntimeRouteKind,
  ProjectWithTasks,
  RuntimeWorkListResponse,
} from '@/types/api'

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

export function getWorkbenchDeviceIds(device: DeviceInfo): string[] {
  return [
    device.device_id,
    device.app_device_id,
    device.socket_device_id,
    device.runtime_instance_id,
    ...(device.runtime_routes?.flatMap(route => [route.device_id, route.runtime_device_id]) ?? []),
  ].flatMap(id => {
    const normalized = id?.trim()
    return normalized ? [normalized] : []
  })
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

export function mergeDeviceLists(
  primaryDevices: DeviceInfo[],
  secondaryDevices: DeviceInfo[]
): DeviceInfo[] {
  return mergeRuntimeDeviceGroups(primaryDevices, secondaryDevices).map(group => group.device)
}

interface RuntimeDeviceGroup {
  device: DeviceInfo
  sources: DeviceInfo[]
}

function mergeRuntimeDeviceGroups(
  primaryDevices: DeviceInfo[],
  secondaryDevices: DeviceInfo[]
): RuntimeDeviceGroup[] {
  const merged: RuntimeDeviceGroup[] = []

  const upsertDevice = (device: DeviceInfo) => {
    let candidate: RuntimeDeviceGroup = { device: withRuntimeRoutes(device), sources: [device] }
    let insertionIndex = merged.length
    let index = 0
    while (index < merged.length) {
      if (!workbenchDevicesShareRuntimeIdentity(merged[index].device, candidate.device)) {
        index += 1
        continue
      }
      insertionIndex = Math.min(insertionIndex, index)
      candidate = {
        device: mergeRuntimeDeviceRecord(merged[index].device, candidate.device),
        sources: [...merged[index].sources, ...candidate.sources],
      }
      merged.splice(index, 1)
      index = 0
    }
    merged.splice(insertionIndex, 0, candidate)
  }

  primaryDevices.forEach(upsertDevice)
  secondaryDevices.forEach(upsertDevice)
  return merged
}

function withRuntimeRoutes(device: DeviceInfo): DeviceInfo {
  return {
    ...device,
    runtime_routes: mergeRuntimeRoutes(device.runtime_routes ?? [], [
      runtimeRouteFromDevice(device),
    ]),
  }
}

function mergeRuntimeDeviceRecord(existing: DeviceInfo, incoming: DeviceInfo): DeviceInfo {
  const preferred = preferDeviceRecord(existing, incoming)
  const fallback = preferred === existing ? incoming : existing
  return {
    ...fallback,
    ...preferred,
    app_device_id: preferred.app_device_id ?? fallback.app_device_id ?? null,
    socket_device_id: preferred.socket_device_id ?? fallback.socket_device_id ?? null,
    runtime_instance_id: preferred.runtime_instance_id ?? fallback.runtime_instance_id ?? null,
    runtime_routes: mergeRuntimeRoutes(existing.runtime_routes ?? [], [
      ...(incoming.runtime_routes ?? []),
      runtimeRouteFromDevice(incoming),
    ]),
  }
}

function preferDeviceRecord(existing: DeviceInfo, incoming: DeviceInfo): DeviceInfo {
  return deviceRecordPriority(incoming) <= deviceRecordPriority(existing) ? incoming : existing
}

function deviceRecordPriority(device: DeviceInfo): number {
  const routeKind = runtimeRouteKind(device)
  if (routeKind === 'local-ipc') return 0
  if (routeKind === 'app-ipc') return 1
  if (routeKind === 'cloud-relay') return 2
  return 3
}

export function workbenchDevicesShareRuntimeIdentity(left: DeviceInfo, right: DeviceInfo): boolean {
  if (left.runtime_instance_id || right.runtime_instance_id) {
    return Boolean(
      left.runtime_instance_id && left.runtime_instance_id === right.runtime_instance_id
    )
  }
  return Boolean(
    Number.isSafeInteger(left.id) &&
    Number.isSafeInteger(right.id) &&
    left.id === right.id &&
    left.device_id.trim() &&
    left.device_id.trim() === right.device_id.trim()
  )
}

function runtimeRouteFromDevice(device: DeviceInfo): DeviceRuntimeRoute {
  return {
    kind: runtimeRouteKind(device),
    device_id: device.device_id,
    runtime_device_id: device.socket_device_id || device.device_id,
    device_type: device.device_type ?? null,
    name: device.name,
    status: device.status,
  }
}

function runtimeRouteKind(device: DeviceInfo): DeviceRuntimeRouteKind {
  if (isCloudDevice(device)) return 'cloud-relay'
  if (isRemoteDevice(device)) return 'remote-relay'
  if (isAppDevice(device)) return 'app-ipc'
  return 'local-ipc'
}

function mergeRuntimeRoutes(
  existingRoutes: DeviceRuntimeRoute[],
  incomingRoutes: DeviceRuntimeRoute[]
): DeviceRuntimeRoute[] {
  const routes = new Map<string, DeviceRuntimeRoute>()
  ;[...existingRoutes, ...incomingRoutes].forEach(route => {
    routes.set(`${route.kind}\0${route.device_id}\0${route.runtime_device_id}`, route)
  })
  return Array.from(routes.values()).sort(
    (left, right) => runtimeRoutePriority(left.kind) - runtimeRoutePriority(right.kind)
  )
}

function runtimeRoutePriority(kind: DeviceRuntimeRouteKind): number {
  if (kind === 'local-ipc') return 0
  if (kind === 'app-ipc') return 0
  if (kind === 'cloud-relay') return 1
  return 2
}

export interface WorkbenchDeviceResolver {
  resolve: (deviceId: string) => DeviceInfo | null
  identityKey: (deviceId: string) => string
}

export class AmbiguousExecutorIdentityError extends Error {
  readonly details: { candidates: Record<string, unknown>[] }

  constructor(deviceId: string, candidates: DeviceInfo[]) {
    super(`ambiguous-executor-identity:${deviceId}`)
    this.name = 'AmbiguousExecutorIdentityError'
    this.details = {
      candidates: candidates.map(device => ({
        recordId: device.id,
        type: device.device_type ?? null,
        status: device.status,
        device_id: device.device_id,
        app_device_id: device.app_device_id ?? null,
        socket_device_id: device.socket_device_id ?? null,
        runtime_instance_id: device.runtime_instance_id ?? null,
        routeKind: runtimeRouteKind(device),
      })),
    }
  }
}

/** Resolve transport aliases once; keep execution addresses separate from equality keys. */
export function createWorkbenchDeviceResolver(devices: DeviceInfo[]): WorkbenchDeviceResolver {
  const aliases = new Map<string, Set<DeviceInfo>>()
  for (const group of mergeRuntimeDeviceGroups(devices, [])) {
    for (const source of [group.device, ...group.sources]) {
      for (const alias of getWorkbenchDeviceIds(source)) {
        const matches = aliases.get(alias) ?? new Set<DeviceInfo>()
        matches.add(group.device)
        aliases.set(alias, matches)
      }
    }
  }
  const resolve = (deviceId: string): DeviceInfo | null => {
    const matches = [...(aliases.get(deviceId.trim()) ?? [])]
    if (matches.length > 1) {
      const error = new AmbiguousExecutorIdentityError(deviceId, matches)
      console.warn('[Wework] Ambiguous executor identity', {
        deviceId: deviceId.trim(),
        candidates: error.details.candidates,
      })
      throw error
    }
    return matches[0] ?? null
  }
  return {
    resolve,
    identityKey(deviceId) {
      const device = resolve(deviceId)
      return device?.runtime_instance_id
        ? `runtime:${device.runtime_instance_id}`
        : `device:${device?.device_id ?? deviceId.trim()}`
    },
  }
}
