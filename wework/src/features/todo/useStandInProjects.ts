import { useMemo, useSyncExternalStore } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { createStandInProjectsStore } from './standInProjectsStore'

export function useStandInProjects(
  services: WorkbenchServices,
  devices: DeviceInfo[] | undefined,
  userId: number
) {
  const deviceIds =
    devices
      ?.filter(device => device.status === 'online' || device.status === 'busy')
      .map(device => device.device_id)
      .sort()
      .join('\n') ?? ''
  const store = useMemo(
    () => createStandInProjectsStore(services, deviceIds, userId),
    [services, deviceIds, userId]
  )
  const settings = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return new Set(
    settings
      .filter(row => row.enabled && row.userId === userId)
      .map(row => `${row.projectStore}:${row.projectId}`)
  )
}
