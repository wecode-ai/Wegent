import { useEffect, useMemo, useRef, useState } from 'react'
import { createHttpClient } from '@/api/http'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
} from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { useLocalExecutorCloudConnectionStatus } from '@/features/cloud-connection/localExecutorCloudConnectionStatus'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { trackPluginEvent as track } from '@/telemetry/businessEvents'
import { createSocketClient } from '@wegent/chat-core'
import { runCurrentDevicePluginAutoUpdate } from './pluginAutoUpdate'
import { createLocalDevicePluginApi, resolveLocalPluginDeviceRouteId } from './pluginDeviceApi'
import { createPluginBackgroundPass } from './pluginBackgroundPass'

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
  const accountController = useRef<AbortController | null>(null)
  const [localSyncScope, setLocalSyncScope] = useState<{
    apiBaseUrl: string
    token: string
    enabled: boolean
  } | null>(null)
  const localSyncAvailable =
    localSyncScope?.apiBaseUrl === cloud.apiBaseUrl &&
    localSyncScope?.token === cloud.token &&
    localSyncScope?.enabled === true
  const runtimeConnected =
    localSyncAvailable ||
    (localExecutorCloudConnection.connected &&
      localExecutorCloudConnection.apiBaseUrl === (cloud.apiBaseUrl || ''))

  useEffect(() => {
    let disposed = false
    let probing = false
    let refresh: (() => void) | undefined
    if (cloud.apiBaseUrl && cloud.token) {
      const profile = { apiBaseUrl: cloud.apiBaseUrl, token: cloud.token }
      const probe = createLocalDevicePluginApi(
        createPluginApi(
          createHttpClient({
            baseUrl: cloud.apiBaseUrl,
            getToken: () => cloud.token,
            redirectOnUnauthorized: false,
          }),
          cloud.apiBaseUrl
        ),
        deviceId => resolveLocalPluginDeviceRouteId(deviceId, profile),
        profile
      )
      refresh = () => {
        if (disposed || probing) return
        probing = true
        void probe
          .supportsLocalSync()
          .then(enabled => {
            if (!disposed)
              setLocalSyncScope(current =>
                current?.apiBaseUrl === profile.apiBaseUrl &&
                current.token === profile.token &&
                current.enabled === enabled
                  ? current
                  : { ...profile, enabled }
              )
          })
          .catch(() => undefined)
          .finally(() => {
            probing = false
          })
      }
      refresh()
    }
    // Runtime readiness and HTTP recovery must not require a successful Device
    // connection event. Reuse the account reconciliation cadence and lifecycle.
    const resume = () => {
      if (navigator.onLine && document.visibilityState !== 'hidden') refresh?.()
    }
    const timer = window.setInterval(resume, 120_000)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [cloud.apiBaseUrl, cloud.token, localExecutorCloudConnection.connected])

  // An accepted sync must survive an Executor disconnect until its HTTP request settles.
  useEffect(() => {
    const controller = new AbortController()
    accountController.current = controller
    return () => {
      controller.abort()
      if (accountController.current === controller) accountController.current = null
    }
  }, [cloud.apiBaseUrl, cloud.isConnected, cloud.token])

  useEffect(() => {
    const controller = accountController.current
    if (
      !controller ||
      !cloud.isConnected ||
      !cloud.apiBaseUrl ||
      (!localSyncAvailable && (!cloud.socketBaseUrl || !cloud.socketPath)) ||
      !cloud.token ||
      !runtimeConnected
    ) {
      return undefined
    }

    const token = cloud.token
    const profile = { apiBaseUrl: cloud.apiBaseUrl, token }
    const cloudPluginApi = createLocalDevicePluginApi(
      createPluginApi(
        createHttpClient({
          baseUrl: cloud.apiBaseUrl,
          getToken: () => token,
          redirectOnUnauthorized: false,
          signal: controller.signal,
        }),
        cloud.apiBaseUrl
      ),
      deviceId => resolveLocalPluginDeviceRouteId(deviceId, profile),
      profile
    )
    const socketClient =
      cloud.socketBaseUrl && cloud.socketPath
        ? createSocketClient({
            socketBaseUrl: () => cloud.socketBaseUrl || '',
            path: cloud.socketPath,
            namespace: '/chat',
            getToken: () => token,
            auth: { client_origin: 'wework' },
            logger: console,
          })
        : null
    let disposed = false
    let connectedTriggerSeen = false
    const waiting = new AbortController()

    const publishLocalChange = () => {
      if (disposed) return
      clearLocalCodexPluginsReadStateCache()
      notifyLocalPluginSkillsChanged()
      window.dispatchEvent(new Event(PLUGIN_AUTO_UPDATE_COMPLETED_EVENT))
    }
    const runUpdatePass = async (): Promise<boolean> => {
      const result = await runCurrentDevicePluginAutoUpdate({
        localSync: localSyncAvailable,
        signal: waiting.signal,
        listLocalInstalledPlugins: () => localPluginApi.listInstalledPlugins({ refresh: true }),
        listMarketplacePlugins: deviceId => cloudPluginApi.listMarketplacePlugins({ deviceId }),
        updateBatch: () => cloudPluginApi.autoUpdateInstalledPlugins(),
        syncPlugin: (deviceId, installedPluginId) =>
          cloudPluginApi.syncInstalledPluginToDevice(installedPluginId, deviceId),
        syncDevice: deviceId => cloudPluginApi.syncInstalledPluginsToDevice(deviceId),
      })
      if (
        disposed ||
        !result ||
        (result.updatedCount === 0 && result.failedCount === 0 && !result.deviceSyncPerformed)
      ) {
        return false
      }

      publishLocalChange()
      if (result.updatedCount > 0) {
        console.info(
          `[Plugins] Automatically updated ${result.updatedCount} plugin(s) on ${result.deviceId}`
        )
      }
      if (result.failedCount > 0) {
        console.warn('[Plugins] Automatic plugin updates failed', result.failures)
        track('operation_failed', { operation: 'plugin_auto_update' })
      }
      return result.failures.some(failure => failure.retryable === true)
    }

    const updates = createPluginBackgroundPass({
      id: 'plugins.auto-update',
      isCurrent: () => !disposed,
      run: runUpdatePass,
      detached: localSyncAvailable,
      onError: error => {
        console.warn('[Plugins] Automatic update check failed', error)
        track('operation_failed', { operation: 'plugin_auto_update' })
      },
    })
    const reconciliation = localSyncAvailable
      ? createPluginBackgroundPass({
          id: 'plugins.account-reconcile',
          isCurrent: () => !disposed,
          detached: true,
          run: async () => {
            const result = await cloudPluginApi.syncInstalledPluginsToDevice('', true)
            if (result.localChanged) publishLocalChange()
            return false
          },
          onError: error => console.warn('[Plugins] Account plugin reconciliation deferred', error),
        })
      : null
    const requestUpdatePass = () => {
      reconciliation?.request()
      updates.request()
    }
    const handleConnect = () => {
      connectedTriggerSeen = true
      requestUpdatePass()
    }
    const handleReleaseAvailable = (event?: PluginReleaseAvailableEvent) => {
      if (!event || !Number.isInteger(event.releaseId)) return
      requestUpdatePass()
    }

    // One account coordinator owns HTTP reconciliation, including old-client
    // changes that produce neither a new outbox event nor a Device Socket event.
    const poll = window.setInterval(() => {
      if (localSyncAvailable && document.visibilityState !== 'hidden' && navigator.onLine)
        requestUpdatePass()
    }, 120_000)
    const resume = () => {
      if (localSyncAvailable && document.visibilityState !== 'hidden') requestUpdatePass()
    }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    if (localSyncAvailable) requestUpdatePass()

    socketClient?.socket.on('connect', handleConnect)
    socketClient?.socket.on(PLUGIN_RELEASE_AVAILABLE_EVENT, handleReleaseAvailable)
    void socketClient
      ?.ensureConnected()
      .then(() => {
        if (!connectedTriggerSeen) requestUpdatePass()
      })
      .catch(error => {
        if (!disposed) console.warn('[Plugins] Failed to connect update notification socket', error)
      })

    return () => {
      disposed = true
      window.clearInterval(poll)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      waiting.abort()
      updates.dispose()
      reconciliation?.dispose()
      socketClient?.socket.off('connect', handleConnect)
      socketClient?.socket.off(PLUGIN_RELEASE_AVAILABLE_EVENT, handleReleaseAvailable)
      socketClient?.dispose()
    }
  }, [
    cloud.apiBaseUrl,
    cloud.isConnected,
    cloud.socketBaseUrl,
    cloud.socketPath,
    cloud.token,
    localPluginApi,
    runtimeConnected,
    localSyncAvailable,
  ])

  return null
}
