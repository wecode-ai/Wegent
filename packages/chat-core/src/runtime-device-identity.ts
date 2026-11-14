import {
  isAppDevice,
  isCloudDevice,
  isRemoteDevice,
  isRemoteTaskAccessEnabled,
} from './device-capabilities'
import type { DeviceInfo, DeviceRuntimeRoute, DeviceRuntimeRouteKind } from './execution-project'

type DeviceIdentity = Pick<DeviceInfo, 'id' | 'device_id' | 'name' | 'status'> &
  Partial<
    Pick<
      DeviceInfo,
      | 'device_type'
      | 'execution_target_id'
      | 'app_device_id'
      | 'socket_device_id'
      | 'runtime_instance_id'
      | 'runtime_routes'
      | 'runtime_features'
    >
  >

export function getWorkbenchDeviceIds(device: DeviceIdentity): string[] {
  return [
    device.device_id,
    device.execution_target_id,
    device.app_device_id,
    device.socket_device_id,
    device.runtime_instance_id,
    ...(device.runtime_routes?.flatMap(route => [route.device_id, route.runtime_device_id]) ?? []),
  ].flatMap(id => {
    const normalized = id?.trim()
    return normalized ? [normalized] : []
  })
}

export function mergeDeviceLists<T extends DeviceIdentity>(
  primaryDevices: T[],
  secondaryDevices: T[]
): T[] {
  return mergeRuntimeDeviceGroups(primaryDevices, secondaryDevices).map(group => group.device)
}

interface RuntimeDeviceGroup<T extends DeviceIdentity> {
  device: T
  sources: T[]
}

function mergeRuntimeDeviceGroups<T extends DeviceIdentity>(
  primaryDevices: T[],
  secondaryDevices: T[]
): RuntimeDeviceGroup<T>[] {
  const merged: RuntimeDeviceGroup<T>[] = []

  const upsertDevice = (device: T) => {
    let candidate: RuntimeDeviceGroup<T> = {
      device: withRuntimeRoutes(device),
      sources: [device],
    }
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

function withRuntimeRoutes<T extends DeviceIdentity>(device: T): T {
  return {
    ...device,
    runtime_routes: mergeRuntimeRoutes(device.runtime_routes ?? [], [
      runtimeRouteFromDevice(device),
    ]),
  }
}

function mergeRuntimeDeviceRecord<T extends DeviceIdentity>(existing: T, incoming: T): T {
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

function preferDeviceRecord<T extends DeviceIdentity>(existing: T, incoming: T): T {
  return deviceRecordPriority(incoming) <= deviceRecordPriority(existing) ? incoming : existing
}

function deviceRecordPriority(device: DeviceIdentity): number {
  const routeKind = runtimeRouteKind(device)
  if (routeKind === 'local-ipc') return 0
  if (routeKind === 'app-ipc') return 1
  if (routeKind === 'cloud-relay') return 2
  return 3
}

export function workbenchDevicesShareRuntimeIdentity(
  left: DeviceIdentity,
  right: DeviceIdentity
): boolean {
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

function runtimeRouteFromDevice(device: DeviceIdentity): DeviceRuntimeRoute {
  return {
    kind: runtimeRouteKind(device),
    device_id: device.device_id,
    runtime_device_id: device.socket_device_id || device.device_id,
    device_type: device.device_type ?? null,
    name: device.name,
    status: device.status,
  }
}

function runtimeRouteKind(device: DeviceIdentity): DeviceRuntimeRouteKind {
  if (isCloudDevice(device)) return 'cloud-relay'
  if (isRemoteDevice(device)) return 'remote-relay'
  if (isAppDevice(device)) return isRemoteTaskAccessEnabled(device) ? 'remote-relay' : 'app-ipc'
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

export interface WorkbenchDeviceResolver<T extends DeviceIdentity = DeviceIdentity> {
  resolve: (deviceId: string) => T | null
  identityKey: (deviceId: string) => string
}

export class AmbiguousExecutorIdentityError extends Error {
  readonly details: { candidates: Record<string, unknown>[] }

  constructor(deviceId: string, candidates: DeviceIdentity[]) {
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
export function createWorkbenchDeviceResolver<T extends DeviceIdentity>(
  devices: T[]
): WorkbenchDeviceResolver<T> {
  const aliases = new Map<string, Set<T>>()
  for (const group of mergeRuntimeDeviceGroups(devices, [])) {
    for (const source of [group.device, ...group.sources]) {
      for (const alias of getWorkbenchDeviceIds(source)) {
        const matches = aliases.get(alias) ?? new Set<T>()
        matches.add(group.device)
        aliases.set(alias, matches)
      }
    }
  }
  const resolve = (deviceId: string): T | null => {
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
