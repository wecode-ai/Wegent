import type { DeviceInfo } from '@wegent/chat-core/execution-project'
import type { SharedWorkspaceRuntimeApi } from '@wegent/collaboration'

/** Coalesce simultaneous card checks, without retaining a stale device catalog. */
export function createBrowserRuntimeDeviceAccess(
  readDevices: () => Promise<DeviceInfo[]>
): NonNullable<SharedWorkspaceRuntimeApi['checkDeviceAccess']> {
  let pending: Promise<DeviceInfo[]> | null = null
  return async deviceIds => {
    const request = pending ?? (pending = readDevices())
    let devices: DeviceInfo[]
    try {
      devices = await request
    } finally {
      if (pending === request) pending = null
    }
    return Object.fromEntries(
      deviceIds.map(id => {
        const device = devices.find(item => item.device_id === id || String(item.id) === id)
        if (device) return [id, device.device_type === 'app' ? 'app-local-only' : 'allowed']
        for (const candidate of devices) {
          const route = candidate.runtime_routes?.find(
            item => item.device_id === id || item.runtime_device_id === id
          )
          if (route)
            return [
              id,
              (route.device_type ?? candidate.device_type) === 'app' ? 'app-local-only' : 'allowed',
            ]
          if (candidate.app_device_id === id || candidate.socket_device_id === id)
            return [
              id,
              candidate.device_type === 'app' || candidate.app_device_id === id
                ? 'app-local-only'
                : 'allowed',
            ]
        }
        return [id, 'unavailable']
      })
    )
  }
}
