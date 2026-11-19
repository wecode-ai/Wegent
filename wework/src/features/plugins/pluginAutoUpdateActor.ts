import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import {
  getLocalExecutorCloudConnectionStatus,
  subscribeLocalExecutorCloudConnectionStatus,
} from '@/features/cloud-connection/localExecutorCloudConnectionStatus'
import { createPluginAutoUpdateApi, startPluginAutoUpdatePass } from './pluginAutoUpdatePass'

export interface PluginAutoUpdateProfile {
  isConnected: boolean
  apiBaseUrl?: string
  socketBaseUrl?: string
  socketPath?: string
  token: string | null
  userId?: number
}

interface ProbeState {
  apiBaseUrl?: string
  token: string | null
  userId?: number
  runtimeConnected: boolean
  runtimeConfigured: boolean
  dispose(): void
}
interface LocalSyncScope {
  apiBaseUrl: string
  token: string
  userId?: number
  enabled: boolean
}
interface WorkState {
  profile: PluginAutoUpdateProfile
  localSyncAvailable: boolean
  runtimeConnected: boolean
  dispose(): void
}

function sameAccount(left: PluginAutoUpdateProfile, right: PluginAutoUpdateProfile) {
  return (
    left.apiBaseUrl === right.apiBaseUrl &&
    left.token === right.token &&
    left.userId === right.userId &&
    left.isConnected === right.isConnected
  )
}

/** One main renderer owns capability discovery, account HTTP and Runtime-dependent jobs. */
function createWindowPluginAutoUpdateService() {
  const localPluginApi = createLocalCodexPluginApi()
  let profile: PluginAutoUpdateProfile | undefined
  let localSyncScope: LocalSyncScope | undefined
  let controller: AbortController | undefined
  let probe: ProbeState | undefined
  let work: WorkState | undefined
  let releaseRuntime: (() => void) | undefined

  const stopWork = () => {
    work?.dispose()
    work = undefined
  }
  const reconcileWork = () => {
    if (!profile) return
    const runtime = getLocalExecutorCloudConnectionStatus()
    const localSyncAvailable =
      localSyncScope?.apiBaseUrl === profile.apiBaseUrl &&
      localSyncScope?.token === profile.token &&
      localSyncScope?.userId === profile.userId &&
      localSyncScope?.enabled === true
    const runtimeConnected =
      localSyncAvailable || (runtime.connected && runtime.apiBaseUrl === (profile.apiBaseUrl || ''))
    if (
      !controller ||
      !profile.isConnected ||
      !profile.apiBaseUrl ||
      !profile.token ||
      (!localSyncAvailable && (!profile.socketBaseUrl || !profile.socketPath)) ||
      !runtimeConnected
    ) {
      stopWork()
      return
    }
    if (
      work &&
      sameAccount(work.profile, profile) &&
      work.profile.socketBaseUrl === profile.socketBaseUrl &&
      work.profile.socketPath === profile.socketPath &&
      work.localSyncAvailable === localSyncAvailable &&
      work.runtimeConnected === runtimeConnected
    )
      return
    stopWork()
    const pass = startPluginAutoUpdatePass({
      owner: {
        apiBaseUrl: profile.apiBaseUrl,
        token: profile.token,
        socketBaseUrl: profile.socketBaseUrl,
        socketPath: profile.socketPath,
      },
      localSyncAvailable,
      localPluginApi,
      accountSignal: controller.signal,
    })
    work = { profile, localSyncAvailable, runtimeConnected, dispose: pass.dispose }
  }
  const reconcileProbe = () => {
    if (!profile) return
    const runtime = getLocalExecutorCloudConnectionStatus()
    const runtimeConnected = runtime.connected
    const runtimeConfigured = runtime.apiBaseUrl === profile.apiBaseUrl && runtime.configured
    if (
      probe &&
      probe.apiBaseUrl === profile.apiBaseUrl &&
      probe.token === profile.token &&
      probe.userId === profile.userId &&
      probe.runtimeConnected === runtimeConnected &&
      probe.runtimeConfigured === runtimeConfigured
    )
      return
    probe?.dispose()
    const credentials =
      profile.apiBaseUrl && profile.token
        ? { apiBaseUrl: profile.apiBaseUrl, token: profile.token, userId: profile.userId }
        : null
    let disposed = false
    let probing = false
    let refresh: (() => void) | undefined
    if (credentials && runtimeConfigured) {
      const api = createPluginAutoUpdateApi(credentials)
      refresh = () => {
        if (disposed || probing) return
        probing = true
        void api
          .supportsLocalSync()
          .then(enabled => {
            if (disposed) return
            if (
              localSyncScope?.apiBaseUrl === credentials.apiBaseUrl &&
              localSyncScope?.token === credentials.token &&
              localSyncScope?.userId === credentials.userId &&
              localSyncScope?.enabled === enabled
            )
              return
            localSyncScope = { ...credentials, enabled }
            reconcileWork()
          })
          .catch(() => undefined)
          .finally(() => {
            probing = false
          })
      }
      refresh()
    }
    const resume = () => {
      if (navigator.onLine && document.visibilityState !== 'hidden') refresh?.()
    }
    const timer = window.setInterval(resume, 120_000)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    probe = {
      apiBaseUrl: profile.apiBaseUrl,
      token: profile.token,
      userId: profile.userId,
      runtimeConnected,
      runtimeConfigured,
      dispose() {
        disposed = true
        window.clearInterval(timer)
        window.removeEventListener('online', resume)
        document.removeEventListener('visibilitychange', resume)
      },
    }
  }
  const runtimeChanged = () => {
    reconcileProbe()
    reconcileWork()
  }
  return {
    observe(next: PluginAutoUpdateProfile) {
      const accountChanged = !profile || !sameAccount(profile, next)
      if (accountChanged) {
        stopWork()
        controller?.abort()
        controller = new AbortController()
      }
      profile = { ...next }
      if (!releaseRuntime)
        releaseRuntime = subscribeLocalExecutorCloudConnectionStatus(runtimeChanged)
      reconcileProbe()
      reconcileWork()
    },
    disconnect() {
      stopWork()
      probe?.dispose()
      probe = undefined
      controller?.abort()
      controller = undefined
      releaseRuntime?.()
      releaseRuntime = undefined
      profile = undefined
      localSyncScope = undefined
    },
  }
}

let currentOwner: object | undefined
let windowService: ReturnType<typeof createWindowPluginAutoUpdateService> | undefined

/** Route ownership can transfer in one commit without the former host stopping its successor. */
export function createPluginAutoUpdateActor() {
  const owner = {}
  return {
    observe(profile: PluginAutoUpdateProfile | null) {
      currentOwner = owner
      if (!profile) {
        windowService?.disconnect()
        windowService = undefined
        return
      }
      windowService ??= createWindowPluginAutoUpdateService()
      windowService.observe(profile)
    },
    disconnect() {
      if (currentOwner !== owner) return
      currentOwner = undefined
      windowService?.disconnect()
      windowService = undefined
    },
  }
}
