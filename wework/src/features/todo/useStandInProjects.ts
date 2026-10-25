import { useEffect, useState } from 'react'
import { subscribeStandInSettings, type StandInProjectSettings } from '@/api/standIn'
import { subscribePersonalStandIn } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'

export function useStandInProjects(
  services: WorkbenchServices,
  devices: DeviceInfo[] | undefined,
  userId: number
) {
  const [settings, setSettings] = useState<StandInProjectSettings[]>([])
  const deviceIds =
    devices
      ?.filter(device => device.status === 'online' || device.status === 'busy')
      .map(device => device.device_id)
      .sort()
      .join('\n') ?? ''
  useEffect(() => {
    let active = true
    const changed = new Map<string, StandInProjectSettings>()
    const key = (value: StandInProjectSettings) =>
      `${value.executionDeviceId}:${value.projectStore}:${value.projectId}:${value.id ?? 'default'}`
    const unsubscribe = subscribeStandInSettings(value => {
      if (value.userId !== userId) return
      changed.set(key(value), value)
      setSettings(current => [...current.filter(row => key(row) !== key(value)), value])
    })
    const unsubscribePersonal = subscribePersonalStandIn(value => {
      if (value.userId !== userId) return
      void services.standInApi
        ?.list(userId, value.executionDeviceId, true)
        .then(rows => {
          if (active)
            setSettings(current => [
              ...current.filter(row => row.executionDeviceId !== value.executionDeviceId),
              ...rows,
            ])
        })
        .catch(error => console.warn('[Wework] Failed to refresh Stand-in project state', error))
    })
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      const targets = new Set(deviceIds.split('\n').filter(Boolean))
      if (identity?.deviceId) targets.add(identity.deviceId)
      await Promise.allSettled(
        [...targets].map(async deviceId => {
          const rows = await services.standInApi?.list(userId, deviceId)
          if (!active || !rows) return
          setSettings(current => [
            ...current.filter(row => row.executionDeviceId !== deviceId),
            ...rows.map(row => changed.get(key(row)) ?? row),
            ...[...changed.values()].filter(
              row =>
                row.executionDeviceId === deviceId &&
                !rows.some(existing => key(existing) === key(row))
            ),
          ])
        })
      )
    })().catch(error => console.warn('[Wework] Failed to load Stand-in settings', error))
    return () => {
      active = false
      unsubscribe()
      unsubscribePersonal()
    }
  }, [services, deviceIds, userId])
  return new Set(
    settings
      .filter(row => row.enabled && row.userId === userId)
      .map(row => `${row.projectStore}:${row.projectId}`)
  )
}
