import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import type { DeviceInfo } from '@/types/devices'
import { createSettingsDeviceApi, type CloudSettingsConnection } from './settings-cloud-api'

const VERSION_INFO_RETRY_DELAY_MS = 1_500

/** The first discovery may precede version metadata; refresh it once while observed. */
export function createSettingsDeviceCollection(connection: CloudSettingsConnection) {
  let initialRead = true
  let versionTimer: ReturnType<typeof setTimeout> | undefined
  const clearVersionTimer = () => {
    clearTimeout(versionTimer)
    versionTimer = undefined
  }
  const resource = createAsyncResource<DeviceInfo[]>(
    'settings/devices',
    async signal => {
      await Promise.resolve()
      signal.throwIfAborted()
      if (!connection.isConnected) return []
      return createSettingsDeviceApi(connection).getAllDevices()
    },
    {
      refreshOnSubscribe: true,
      success(devices) {
        const checkVersion = initialRead
        initialRead = false
        if (
          checkVersion &&
          devices.some(
            device =>
              device.status !== 'offline' &&
              Boolean(device.executor_version) &&
              device.latest_version == null &&
              device.update_available === false
          )
        ) {
          versionTimer = setTimeout(() => {
            versionTimer = undefined
            void resource.reload()
          }, VERSION_INFO_RETRY_DELAY_MS)
        }
      },
      failure() {
        initialRead = false
      },
    }
  )
  return {
    getSnapshot: resource.getSnapshot,
    getServerSnapshot: getIdleResourceSnapshot,
    reload: resource.reload,
    update(devices: DeviceInfo[]) {
      initialRead = false
      clearVersionTimer()
      resource.update(() => devices)
    },
    subscribe(listener: () => void) {
      if (!resource.hasSubscribers()) initialRead = true
      const unsubscribe = resource.subscribe(listener)
      return () => {
        unsubscribe()
        if (!resource.hasSubscribers()) clearVersionTimer()
      }
    },
  }
}
