import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getLocalProxyUrl } from '@/features/model-settings/localProxySettings'

export const LOCAL_EXECUTOR_COMMANDS = {
  codexHomeMigrationStatus: 'local_executor_codex_home_migration_status',
  copyDebugInfo: 'local_executor_copy_debug_info',
  ensure: 'local_executor_ensure_started',
  initializeBundledPluginMarketplace: 'local_executor_initialize_bundled_plugin_marketplace',
  status: 'local_executor_status',
  readLog: 'local_executor_read_log',
  request: 'local_executor_request',
  connectBackend: 'local_executor_connect_backend',
  disconnectBackend: 'local_executor_disconnect_backend',
} as const

export const LOCAL_EXECUTOR_EVENT = 'local-executor:event'

export interface LocalExecutorStatus {
  running: boolean
  ready?: boolean
  deviceId?: string
  runtimeInstanceId?: string
  codexInitializeElapsedMs?: number
  version?: string
  error?: string
}

export interface LocalExecutorLog {
  path: string
  content: string
  truncated: boolean
  lineCount: number
  transport: 'stdio'
  transportConnected: boolean
  processPids: number[]
  processPaths: string[]
  sidecarSource: string
  sidecarPath: string
  currentDir: string
  executorHome: string
  backendUrl: string | null
  hasBackendAuthToken: boolean
  pendingRequestCount: number
  status: LocalExecutorStatus
}

export interface LocalExecutorEvent {
  event: string
  payload: Record<string, unknown>
}

export interface LocalExecutorBackendConnection {
  backendUrl: string
  authToken: string
}

export interface BundledPluginMarketplace {
  id: string
  path: string
  pluginCount: number
}

let ensureLocalExecutorStartedPromise: Promise<LocalExecutorStatus> | null = null
let initializedLocalExecutorStatus: LocalExecutorStatus | null = null
let initializedBundledPluginMarketplace: BundledPluginMarketplace | null = null
let reconciledBundledPluginMarketplaceKey = ''
let reconcilingBundledPluginMarketplaceKey = ''
let reconcileBundledPluginMarketplacePromise: Promise<void> | null = null

function isExecutorHealthy(status: LocalExecutorStatus): boolean {
  return status.running && status.ready !== false && !status.error
}

function normalizedMarketplacePath(path: string | null | undefined): string {
  return (path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

async function reconcileBundledPluginMarketplace(
  marketplace: BundledPluginMarketplace,
  runtimeInstanceId: string | undefined
): Promise<void> {
  const reconciliationKey = [
    runtimeInstanceId || 'current-runtime',
    normalizedMarketplacePath(marketplace.path),
  ].join(':')
  if (reconciledBundledPluginMarketplaceKey === reconciliationKey) return

  const addMarketplace = () =>
    invoke<{ marketplaceName: string }>(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'codex.app_server_request',
      params: {
        method: 'marketplace/add',
        params: {
          source: marketplace.path,
          refName: null,
          sparsePaths: null,
        },
      },
    })

  let added: { marketplaceName: string }
  try {
    added = await addMarketplace()
  } catch (addError) {
    const available = await invoke<{
      marketplaces: Array<{ name: string; path?: string | null }>
    }>(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'codex.app_server_request',
      params: {
        method: 'plugin/list',
        params: {
          cwds: null,
          marketplaceKinds: ['local'],
        },
      },
    })
    const existing = available.marketplaces.find(candidate => candidate.name === marketplace.id)
    if (
      existing &&
      normalizedMarketplacePath(existing.path) === normalizedMarketplacePath(marketplace.path)
    ) {
      reconciledBundledPluginMarketplaceKey = reconciliationKey
      return
    }
    if (!existing) {
      throw new Error(`Bundled plugin marketplace ${marketplace.id} could not be registered`, {
        cause: addError,
      })
    }
    await invoke(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'codex.app_server_request',
      params: {
        method: 'marketplace/remove',
        params: { marketplaceName: marketplace.id },
      },
    })
    added = await addMarketplace()
  }
  if (added.marketplaceName !== marketplace.id) {
    throw new Error(
      `Bundled plugin marketplace resolved to ${added.marketplaceName || 'an unknown name'}`
    )
  }
  reconciledBundledPluginMarketplaceKey = reconciliationKey
}

export async function ensureBundledPluginMarketplaceRegistered(): Promise<void> {
  const marketplace = initializedBundledPluginMarketplace
  const status = initializedLocalExecutorStatus
  if (!marketplace || !status) return
  if (!isExecutorHealthy(status)) return
  const reconciliationKey = [
    status.runtimeInstanceId || 'current-runtime',
    normalizedMarketplacePath(marketplace.path),
  ].join(':')
  if (
    reconciledBundledPluginMarketplaceKey === reconciliationKey ||
    (reconcilingBundledPluginMarketplaceKey === reconciliationKey &&
      reconcileBundledPluginMarketplacePromise)
  ) {
    return reconcileBundledPluginMarketplacePromise ?? Promise.resolve()
  }

  reconcilingBundledPluginMarketplaceKey = reconciliationKey
  const reconciliation = reconcileBundledPluginMarketplace(
    marketplace,
    status.runtimeInstanceId
  ).finally(() => {
    if (reconcileBundledPluginMarketplacePromise === reconciliation) {
      reconcileBundledPluginMarketplacePromise = null
      reconcilingBundledPluginMarketplaceKey = ''
    }
  })
  reconcileBundledPluginMarketplacePromise = reconciliation
  return reconciliation
}

export function getInitializedBundledPluginMarketplace(): BundledPluginMarketplace | null {
  return initializedBundledPluginMarketplace
}

export function ensureLocalExecutorStarted(): Promise<LocalExecutorStatus> {
  if (!ensureLocalExecutorStartedPromise) {
    ensureLocalExecutorStartedPromise = (async () => {
      const marketplace = await invoke<BundledPluginMarketplace>(
        LOCAL_EXECUTOR_COMMANDS.initializeBundledPluginMarketplace
      )
      if (marketplace?.path) {
        initializedBundledPluginMarketplace = marketplace
      }
      const proxyUrl = getLocalProxyUrl().trim()
      const status = await invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.ensure, {
        proxyUrl: proxyUrl || null,
      })
      initializedLocalExecutorStatus = status
      return status
    })().finally(() => {
      ensureLocalExecutorStartedPromise = null
    })
  }

  return ensureLocalExecutorStartedPromise
}

export function resetLocalExecutorStateForTests(): void {
  ensureLocalExecutorStartedPromise = null
  initializedLocalExecutorStatus = null
  initializedBundledPluginMarketplace = null
  reconciledBundledPluginMarketplaceKey = ''
  reconcilingBundledPluginMarketplaceKey = ''
  reconcileBundledPluginMarketplacePromise = null
}

export function getLocalExecutorStatus(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.status)
}

export function readLocalExecutorLog(): Promise<LocalExecutorLog> {
  return invoke<LocalExecutorLog>(LOCAL_EXECUTOR_COMMANDS.readLog)
}

export function copyLocalExecutorDebugInfo(text: string): Promise<void> {
  return invoke<void>(LOCAL_EXECUTOR_COMMANDS.copyDebugInfo, { text })
}

export function connectLocalExecutorToBackend(
  connection: LocalExecutorBackendConnection
): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.connectBackend, {
    backendUrl: connection.backendUrl,
    authToken: connection.authToken,
  })
}

export function disconnectLocalExecutorFromBackend(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.disconnectBackend)
}

export function requestLocalExecutor<T = unknown>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return invoke<T>(LOCAL_EXECUTOR_COMMANDS.request, { method, params })
}

export function subscribeLocalExecutorEvents(
  handler: (event: LocalExecutorEvent) => void
): Promise<UnlistenFn> {
  return listen<LocalExecutorEvent>(LOCAL_EXECUTOR_EVENT, event => {
    handler(event.payload)
  })
}
