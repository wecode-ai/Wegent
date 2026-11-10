import { useEffect, useState } from 'react'
import { subscribePersonalStandIn, type StandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'

export interface StandInRoleLocation {
  role: StandInRole
  deviceId: string
}

/** Follow saved role locations without changing the primary conversation's device. */
export function useStandInRoleDirectory(
  api: StandInExecutorApi | undefined,
  userId: number,
  rootDevice: string | undefined,
  active: boolean,
  localDevice?: string,
  entryRequestKey?: number
) {
  const [revision, setRevision] = useState(0)
  const scope = JSON.stringify([userId, rootDevice, localDevice])
  const [data, setData] = useState<{
    scope: string
    roles: StandInRoleLocation[]
    error?: string
  }>()
  useEffect(
    () =>
      subscribePersonalStandIn(value => {
        if (value.userId === userId) setRevision(current => current + 1)
      }),
    [userId]
  )
  useEffect(() => {
    if (!active || !api || !rootDevice) return
    let current = true
    void (async () => {
      const visited = new Set<string>()
      const pending = [
        ...new Set([rootDevice, localDevice].filter((device): device is string => !!device)),
      ]
      const roles = new Map<string, StandInRoleLocation>()
      const loadedRoles = new Map<string, Set<string>>()
      let error: string | undefined
      let loaded = false
      while (pending.length) {
        if (!current) return
        const devices = pending.splice(0, 4).filter(device => !visited.has(device))
        devices.forEach(device => visited.add(device))
        await Promise.allSettled(
          devices.map(async device => {
            try {
              const profile = await api.personalGet(userId, device)
              if (!current) return
              loaded = true
              const profileKeys = new Set(
                profile.roles.map(
                  role =>
                    role.migrationSource ??
                    JSON.stringify([profile.executionDeviceId, userId, role.id])
                )
              )
              loadedRoles.set(device, profileKeys)
              for (const [key, entry] of roles) {
                if (entry.deviceId === device && !profileKeys.has(key)) roles.delete(key)
              }
              for (const role of profile.roles) {
                if (device !== rootDevice && !role.name && !role.prompt && !role.enabled) continue
                const key =
                  role.migrationSource ??
                  JSON.stringify([profile.executionDeviceId, userId, role.id])
                const targetRoles = loadedRoles.get(role.executionDeviceId)
                if (targetRoles && !targetRoles.has(key)) continue
                const previous = roles.get(key)
                if (!previous || role.executionDeviceId === device) {
                  roles.set(key, { role, deviceId: role.executionDeviceId })
                }
                if (!visited.has(role.executionDeviceId)) pending.push(role.executionDeviceId)
              }
            } catch (cause) {
              error = getStandInErrorMessage(cause)
            }
            if (current)
              setData(previous =>
                roles.size || loaded || previous?.scope !== scope
                  ? { scope, roles: [...roles.values()], error }
                  : { ...previous, error }
              )
          })
        )
      }
    })()
    return () => {
      current = false
    }
  }, [api, userId, rootDevice, active, revision, scope, localDevice, entryRequestKey])
  return data?.scope === scope ? data : undefined
}
