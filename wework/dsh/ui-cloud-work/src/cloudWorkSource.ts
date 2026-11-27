import type { DeviceInfo, RuntimeProjectWork } from '@/types/api'
import type { DeviceInfo as ManagedDeviceInfo } from '@/types/devices'

interface Input {
  devices: DeviceInfo[]
  projects: RuntimeProjectWork[] | undefined
  refresh(): Promise<unknown>
}

function projectInventory({ devices, projects }: Pick<Input, 'devices' | 'projects'>) {
  const cloudDevices = devices.flatMap(device => {
    if (device.device_type !== 'cloud' && device.device_type !== 'remote') return []
    const managed: ManagedDeviceInfo = {
      ...device,
      device_type: device.device_type,
      bind_shell: device.bind_shell === 'openclaw' ? 'openclaw' : 'claudecode',
    }
    return [managed]
  })
  const cloudDeviceIds = new Set(cloudDevices.map(device => device.device_id))
  const cloudProjects = (projects ?? []).filter(project => {
    const stateDeviceId = project.project.stateDeviceId
    return (
      (stateDeviceId ? cloudDeviceIds.has(stateDeviceId) : false) ||
      project.deviceWorkspaces.some(workspace => cloudDeviceIds.has(workspace.deviceId))
    )
  })
  return { cloudDevices, cloudDeviceIds, cloudProjects }
}

/** Project the account's live inventory and refresh once when this reader becomes active. */
export function createCloudWorkSource(initial: Input) {
  let input = initial
  let snapshot = projectInventory(initial)
  let active = false
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: Input) {
      const changed = next.devices !== input.devices || next.projects !== input.projects
      input = next
      listeners.add(listener)
      if (changed) {
        snapshot = projectInventory(next)
        for (const observer of listeners) observer()
      }
      if (!active) {
        active = true
        // Callback identity also changes when inventory arrives; that is not a new activation.
        void next.refresh().catch(error => {
          console.warn('[Wework] Cloud work inventory refresh failed', error)
        })
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (!listeners.size) active = false
        })
      }
    },
  }
}
