import { subscribeStandInSettings, type StandInProjectSettings } from '@/api/standIn'
import { subscribePersonalStandIn } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

const key = (value: StandInProjectSettings) =>
  `${value.executionDeviceId}:${value.projectStore}:${value.projectId}:${value.id ?? 'default'}`

/** Device responses merge only saves made since that read began. */
export function createStandInProjectsStore(
  services: WorkbenchServices,
  deviceIds: string,
  userId: number
) {
  let settings: StandInProjectSettings[] = []
  let epoch = 0
  let disconnect: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: StandInProjectSettings[]) => {
    settings = next
    listeners.forEach(listener => listener())
  }
  const connect = () => {
    const generation = ++epoch
    let mutation = 0
    const changes = new Map<string, { value: StandInProjectSettings; mutation: number }>()
    const requests = new Map<string, number>()
    const current = () => generation === epoch && listeners.size > 0
    const loadDevice = async (deviceId: string, forceRefresh = false) => {
      const revision = (requests.get(deviceId) ?? 0) + 1
      requests.set(deviceId, revision)
      const startedAt = mutation
      const rows = await (forceRefresh
        ? services.standInApi?.list(userId, deviceId, true)
        : services.standInApi?.list(userId, deviceId))
      if (!current() || !rows || requests.get(deviceId) !== revision) return
      const changed = [...changes.values()].filter(
        change => change.mutation > startedAt && change.value.executionDeviceId === deviceId
      )
      const replacements = new Map(changed.map(change => [key(change.value), change.value]))
      publish([
        ...settings.filter(row => row.executionDeviceId !== deviceId),
        ...rows.map(row => replacements.get(key(row)) ?? row),
        ...changed
          .map(change => change.value)
          .filter(row => !rows.some(existing => key(existing) === key(row))),
      ])
    }
    const unsubscribe = subscribeStandInSettings(value => {
      if (!current() || value.userId !== userId) return
      changes.set(key(value), { value, mutation: ++mutation })
      publish([...settings.filter(row => key(row) !== key(value)), value])
    })
    const unsubscribePersonal = subscribePersonalStandIn(value => {
      if (!current() || value.userId !== userId) return
      void loadDevice(value.executionDeviceId, true).catch(error => {
        if (current()) console.warn('[Wework] Failed to refresh Stand-in project state', error)
      })
    })
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!current()) return
      const targets = new Set(deviceIds.split('\n').filter(Boolean))
      if (identity?.deviceId) targets.add(identity.deviceId)
      await Promise.allSettled([...targets].map(deviceId => loadDevice(deviceId)))
    })().catch(error => {
      if (current()) console.warn('[Wework] Failed to load Stand-in settings', error)
    })
    return () => {
      epoch++
      unsubscribe()
      unsubscribePersonal()
    }
  }
  return {
    getSnapshot: () => settings,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) disconnect = connect()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          disconnect?.()
          disconnect = undefined
        }
      }
    },
  }
}
