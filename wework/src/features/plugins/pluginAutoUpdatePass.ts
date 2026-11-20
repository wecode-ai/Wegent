import { hasPendingPluginRecovery, PLUGIN_LOCAL_RECOVERY_REQUESTED } from './pluginLocalSync'
import { createHttpClient } from '@/api/http'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
} from '@/api/local/codexPlugins'
import { createPluginApi } from '@/api/plugins'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { trackPluginEvent as track } from '@/telemetry/businessEvents'
import { createSocketClient } from '@wegent/chat-core'
import { runCurrentDevicePluginAutoUpdate } from './pluginAutoUpdate'
import {
  createLocalDevicePluginApi,
  resolveLocalPluginDeviceRouteId,
  type PluginRuntimeProfile,
} from './pluginDeviceApi'
import { createPluginBackgroundPass } from './pluginBackgroundPass'
import {
  PLUGIN_RELEASE_AVAILABLE_EVENT,
  PLUGIN_AUTO_UPDATE_COMPLETED_EVENT,
} from './pluginAutoUpdateEvents'
interface PluginReleaseAvailableEvent {
  pluginId: number
  releaseId: number
  version: string
}
export function createPluginAutoUpdateApi(profile: PluginRuntimeProfile, signal?: AbortSignal) {
  return createLocalDevicePluginApi(
    createPluginApi(
      createHttpClient({
        baseUrl: profile.apiBaseUrl,
        getToken: () => profile.token,
        redirectOnUnauthorized: false,
        signal,
      }),
      profile.apiBaseUrl
    ),
    deviceId => resolveLocalPluginDeviceRouteId(deviceId, profile),
    profile
  )
}
/** A connected Runtime owns scheduling and Socket listeners; accepted HTTP work owns the account signal. */
export function startPluginAutoUpdatePass({
  owner,
  localSyncAvailable,
  localPluginApi,
  accountSignal,
}: {
  owner: { apiBaseUrl: string; token: string; socketBaseUrl?: string; socketPath?: string }
  localSyncAvailable: boolean
  localPluginApi: ReturnType<typeof createLocalCodexPluginApi>
  accountSignal: AbortSignal
}) {
  const token = owner.token
  const profile = { apiBaseUrl: owner.apiBaseUrl, token }
  const cloudPluginApi = createPluginAutoUpdateApi(profile, accountSignal)
  const socketClient =
    owner.socketBaseUrl && owner.socketPath
      ? createSocketClient({
          socketBaseUrl: () => owner.socketBaseUrl || '',
          path: owner.socketPath,
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
  let recovering = false
  let recoveryAttempts = 0
  const retryRecovery = async () => {
    if (disposed || !navigator.onLine || recoveryAttempts >= 8) return false
    const delay = Math.min(500 * 2 ** recoveryAttempts++, 5_000)
    await new Promise(resolve => window.setTimeout(resolve, delay))
    return !disposed && navigator.onLine
  }
  const reconciliation = localSyncAvailable
    ? createPluginBackgroundPass({
        id: 'plugins.account-reconcile',
        isCurrent: () => !disposed,
        detached: true,
        run: async () => {
          try {
            const result = await cloudPluginApi.syncInstalledPluginsToDevice('', true)
            if (disposed) return false
            if (result.localChanged) publishLocalChange()
            if (result.pendingCount > 0) {
              recovering = true
              return retryRecovery()
            }
            recovering = false
            recoveryAttempts = 0
            return false
          } catch (error) {
            if (hasPendingPluginRecovery(error)) recovering = true
            if (
              recovering &&
              (hasPendingPluginRecovery(error) ||
                (error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  error.code === 'plugin_local_sync_busy'))
            ) {
              return retryRecovery()
            }
            throw error
          }
        },
        onError: error => console.warn('[Plugins] Account plugin reconciliation deferred', error),
      })
    : null
  const requestUpdatePass = () => {
    recoveryAttempts = 0
    reconciliation?.request()
    updates.request()
  }
  const requestRecovery = () => {
    recovering = true
    recoveryAttempts = 0
    reconciliation?.request()
  }
  window.addEventListener(PLUGIN_LOCAL_RECOVERY_REQUESTED, requestRecovery)
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

  return {
    dispose() {
      disposed = true
      window.clearInterval(poll)
      window.removeEventListener('online', resume)
      window.removeEventListener(PLUGIN_LOCAL_RECOVERY_REQUESTED, requestRecovery)
      document.removeEventListener('visibilitychange', resume)
      waiting.abort()
      updates.dispose()
      reconciliation?.dispose()
      socketClient?.socket.off('connect', handleConnect)
      socketClient?.socket.off(PLUGIN_RELEASE_AVAILABLE_EVENT, handleReleaseAvailable)
      socketClient?.dispose()
    },
  }
}
