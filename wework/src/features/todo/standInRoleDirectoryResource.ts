import { subscribePersonalStandIn, type StandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { createAsyncResource } from '@wegent/chat-core/async-resource'

export interface StandInRoleLocation {
  role: StandInRole
  deviceId: string
}
interface DirectoryState {
  scope: string
  roles: StandInRoleLocation[]
  failure?: { cause: unknown }
}
export interface DirectoryRequest {
  devices: readonly string[]
  entryRequestKey?: number
}

/** Discover a scoped graph progressively while active consumers own its native subscription. */
export function createStandInRoleDirectoryResource(
  api: StandInExecutorApi,
  userId: number,
  rootDevice: string,
  localDevice?: string
) {
  const scope = JSON.stringify([userId, rootDevice, localDevice])
  const listeners = new Set<() => void>()
  let data: DirectoryState | undefined
  let request: DirectoryRequest = { devices: [] }
  let stopQuery: (() => void) | undefined
  let stopEvents: (() => void) | undefined
  function publish(value: DirectoryState) {
    if (data === value) return
    data = value
    listeners.forEach(listener => listener())
  }
  const query = createAsyncResource(
    scope,
    async signal => {
      const pending = [
        ...new Set(
          [rootDevice, localDevice, ...request.devices].filter(
            (device): device is string => !!device
          )
        ),
      ]
      const discovered = new Set(pending)
      const roles = new Map<string, StandInRoleLocation>()
      const loadedRoles = new Map<string, Set<string>>()
      let failure: DirectoryState['failure']
      let loaded = false
      while (pending.length) {
        signal.throwIfAborted()
        const devices = pending.splice(0, 4)
        await Promise.allSettled(
          devices.map(async device => {
            try {
              const profile = await api.personalGet(userId, device)
              if (signal.aborted) return
              loaded = true
              const keyFor = (role: StandInRole) =>
                role.migrationSource ?? JSON.stringify([profile.executionDeviceId, userId, role.id])
              const profileKeys = new Set(profile.roles.map(keyFor))
              loadedRoles.set(device, profileKeys)
              for (const [key, entry] of roles) {
                if (entry.deviceId === device && !profileKeys.has(key)) roles.delete(key)
              }
              for (const role of profile.roles) {
                if (device !== rootDevice && !role.name && !role.prompt && !role.enabled) continue
                const key = keyFor(role)
                const targetRoles = loadedRoles.get(role.executionDeviceId)
                if (targetRoles && !targetRoles.has(key)) continue
                const previous = roles.get(key)
                if (!previous || role.executionDeviceId === device)
                  roles.set(key, { role, deviceId: role.executionDeviceId })
                if (!discovered.has(role.executionDeviceId)) {
                  discovered.add(role.executionDeviceId)
                  pending.push(role.executionDeviceId)
                }
              }
            } catch (cause) {
              if (signal.aborted) return
              failure = { cause }
            }
            if (!signal.aborted)
              publish({
                scope,
                roles: roles.size || loaded ? [...roles.values()] : (data?.roles ?? []),
                failure,
              })
          })
        )
      }
      return data ?? { scope, roles: [] }
    },
    { refreshOnSubscribe: true }
  )

  const publishQuery = () => {
    const state = query.getSnapshot()
    if (state.status === 'ready' && state.data) publish(state.data)
    else if (state.status === 'error')
      publish({ scope, roles: data?.roles ?? [], failure: { cause: state.error } })
  }
  return {
    getSnapshot: () => data,
    subscribe(listener: () => void, next: DirectoryRequest) {
      const changed = request !== next
      request = next
      listeners.add(listener)
      if (listeners.size === 1) {
        stopEvents = subscribePersonalStandIn(value => {
          if (value.userId === userId) void query.reload()
        })
        stopQuery = query.subscribe(publishQuery)
      } else if (changed) void query.reload()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          stopEvents?.()
          stopEvents = undefined
          stopQuery?.()
          stopQuery = undefined
        }
      }
    },
  }
}
