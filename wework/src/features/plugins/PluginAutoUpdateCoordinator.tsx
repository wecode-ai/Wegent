import { useEffect, useMemo } from 'react'
import { createHttpClient } from '@/api/http'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
} from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { useLocalExecutorCloudConnectionStatus } from '@/features/cloud-connection/localExecutorCloudConnectionStatus'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { scheduleIdleTask } from '@/features/idle-tasks/idleTaskScheduler'
import { track } from '@/telemetry/client'
import { createSocketClient } from '@wegent/chat-core'
import { runCurrentDevicePluginAutoUpdate } from './pluginAutoUpdate'

export const PLUGIN_RELEASE_AVAILABLE_EVENT = 'plugin:release_available'
export const PLUGIN_AUTO_UPDATE_COMPLETED_EVENT = 'wework:plugin-auto-update-completed'

interface PluginReleaseAvailableEvent {
  pluginId: number
  releaseId: number
  version: string
}

export function PluginAutoUpdateCoordinator() {
  const cloud = useOptionalCloudConnection()
  const localExecutorCloudConnection = useLocalExecutorCloudConnectionStatus()
  const localPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const cloudPluginApi = useMemo(() => {
    if (!cloud.apiBaseUrl || !cloud.token) return null
    return createPluginApi(
      createHttpClient({
        baseUrl: cloud.apiBaseUrl,
        getToken: () => cloud.token,
        redirectOnUnauthorized: false,
      }),
      cloud.apiBaseUrl
    )
  }, [cloud.apiBaseUrl, cloud.token])
  const runtimeConnected =
    localExecutorCloudConnection.connected &&
    localExecutorCloudConnection.apiBaseUrl === (cloud.apiBaseUrl || '')

  useEffect(() => {
    if (
      !cloud.isConnected ||
      !cloud.apiBaseUrl ||
      !cloud.socketBaseUrl ||
      !cloud.socketPath ||
      !cloud.token ||
      !cloudPluginApi ||
      !runtimeConnected
    ) {
      return undefined
    }

    const token = cloud.token
    const socketClient = createSocketClient({
      socketBaseUrl: () => cloud.socketBaseUrl || '',
      path: cloud.socketPath,
      namespace: '/chat',
      getToken: () => token,
      auth: { client_origin: 'wework' },
      logger: console,
    })
    let disposed = false
    let running = false
    let pending = false
    let connectedTriggerSeen = false
    let cancelScheduledUpdate: (() => void) | null = null

    const runUpdatePass = async () => {
      const result = await runCurrentDevicePluginAutoUpdate({
        listLocalInstalledPlugins: () =>
          localPluginApi.listInstalledPlugins({ refresh: true, shareInflight: true }),
        listMarketplacePlugins: deviceId => cloudPluginApi.listMarketplacePlugins({ deviceId }),
        updateBatch: () => cloudPluginApi.autoUpdateInstalledPlugins(),
        syncDevice: deviceId => cloudPluginApi.syncInstalledPluginsToDevice(deviceId),
      })
      if (!result || (result.updatedCount === 0 && !result.deviceSyncPerformed)) return

      clearLocalCodexPluginsReadStateCache()
      notifyLocalPluginSkillsChanged()
      window.dispatchEvent(new Event(PLUGIN_AUTO_UPDATE_COMPLETED_EVENT))
      if (result.updatedCount > 0) {
        console.info(
          `[Plugins] Automatically updated ${result.updatedCount} plugin(s) on ${result.deviceId}`
        )
      }
    }

    const drainUpdateRequests = async () => {
      if (running || disposed) return
      running = true
      try {
        while (pending && !disposed) {
          pending = false
          try {
            await runUpdatePass()
          } catch (error) {
            console.warn('[Plugins] Automatic update check failed', error)
            track('operation_failed', { operation: 'plugin_auto_update' })
          }
        }
      } finally {
        running = false
      }
    }

    const requestUpdatePass = () => {
      if (disposed) return
      pending = true
      cancelScheduledUpdate?.()
      cancelScheduledUpdate = scheduleIdleTask('plugins.auto-update', async () => {
        cancelScheduledUpdate = null
        await drainUpdateRequests()
      })
    }
    const handleConnect = () => {
      connectedTriggerSeen = true
      requestUpdatePass()
    }
    const handleReleaseAvailable = (event?: PluginReleaseAvailableEvent) => {
      if (!event || !Number.isInteger(event.releaseId)) return
      requestUpdatePass()
    }

    socketClient.socket.on('connect', handleConnect)
    socketClient.socket.on(PLUGIN_RELEASE_AVAILABLE_EVENT, handleReleaseAvailable)
    void socketClient
      .ensureConnected()
      .then(() => {
        if (!connectedTriggerSeen) requestUpdatePass()
      })
      .catch(error => {
        if (!disposed) console.warn('[Plugins] Failed to connect update notification socket', error)
      })

    return () => {
      disposed = true
      cancelScheduledUpdate?.()
      socketClient.socket.off('connect', handleConnect)
      socketClient.socket.off(PLUGIN_RELEASE_AVAILABLE_EVENT, handleReleaseAvailable)
      socketClient.dispose()
    }
  }, [
    cloud.apiBaseUrl,
    cloud.isConnected,
    cloud.socketBaseUrl,
    cloud.socketPath,
    cloud.token,
    cloudPluginApi,
    localPluginApi,
    runtimeConnected,
  ])

  return null
}
