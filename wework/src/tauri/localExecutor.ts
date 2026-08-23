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
  socketUrl: string | null
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
  socketBaseUrl: string
  authToken: string
  runtimeAuthToken?: string | null
}

export interface BundledPluginMarketplace {
  id: string
  path: string
  pluginCount: number
  defaultPluginNames?: string[]
}

let ensureLocalExecutorStartedPromise: Promise<LocalExecutorStatus> | null = null
let initializedLocalExecutorStatus: LocalExecutorStatus | null = null
let initializedLocalExecutorProxyUrl: string | null = null
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

function bundledMarketplaceManifestPath(path: string): string {
  return `${normalizedMarketplacePath(path)}/.agents/plugins/marketplace.json`
}

async function installBundledMarketplaceDefaults(
  marketplace: BundledPluginMarketplace
): Promise<void> {
  const defaultPluginNames = marketplace.defaultPluginNames ?? []
  if (defaultPluginNames.length === 0) return
  const response = await invoke<{
    config: { plugins?: Record<string, unknown> | null }
  }>(LOCAL_EXECUTOR_COMMANDS.request, {
    method: 'codex.app_server_request',
    params: {
      method: 'config/read',
      params: {
        includeLayers: false,
        cwd: null,
      },
    },
  })
  const configuredPluginKeys = new Set(Object.keys(response.config.plugins ?? {}))
  for (const pluginName of defaultPluginNames) {
    if (configuredPluginKeys.has(`${pluginName}@${marketplace.id}`)) continue
    // The local path identifies the bundled catalog. Codex resolves each
    // plugin entry's declared source, which may itself be local or remote.
    await invoke(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'codex.app_server_request',
      params: {
        method: 'plugin/install',
        params: {
          marketplacePath: bundledMarketplaceManifestPath(marketplace.path),
          remoteMarketplaceName: null,
          pluginName,
        },
      },
    })
  }
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
  await installBundledMarketplaceDefaults(marketplace)
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

export async function ensureBundledPluginInstalled(pluginName: string): Promise<void> {
  const normalizedPluginName = pluginName.trim()
  if (!normalizedPluginName) throw new Error('Bundled plugin name is required')
  await ensureLocalExecutorStarted()
  const marketplace = initializedBundledPluginMarketplace
  if (!marketplace?.defaultPluginNames?.includes(normalizedPluginName)) {
    throw new Error(`Bundled plugin ${normalizedPluginName} is not installed by default`)
  }
  await ensureBundledPluginMarketplaceRegistered()
}

export function getInitializedBundledPluginMarketplace(): BundledPluginMarketplace | null {
  return initializedBundledPluginMarketplace
}

export function ensureLocalExecutorStarted(): Promise<LocalExecutorStatus> {
  const proxyUrl = getLocalProxyUrl().trim() || null
  if (
    initializedLocalExecutorStatus &&
    isExecutorHealthy(initializedLocalExecutorStatus) &&
    initializedLocalExecutorProxyUrl === proxyUrl
  ) {
    return Promise.resolve(initializedLocalExecutorStatus)
  }
  if (!ensureLocalExecutorStartedPromise) {
    ensureLocalExecutorStartedPromise = (async () => {
      const marketplace = await invoke<BundledPluginMarketplace>(
        LOCAL_EXECUTOR_COMMANDS.initializeBundledPluginMarketplace
      )
      if (marketplace?.path) {
        initializedBundledPluginMarketplace = marketplace
      }
      const status = await invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.ensure, {
        proxyUrl,
      })
      initializedLocalExecutorStatus = status
      initializedLocalExecutorProxyUrl = proxyUrl
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
  initializedLocalExecutorProxyUrl = null
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
    socketUrl: connection.socketBaseUrl,
    authToken: connection.authToken,
    runtimeAuthToken: connection.runtimeAuthToken ?? null,
  })
}

export function disconnectLocalExecutorFromBackend(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.disconnectBackend)
}

export function requestLocalExecutor<T = unknown>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return invoke<T>(LOCAL_EXECUTOR_COMMANDS.request, { method, params }).catch((cause: unknown) => {
    const error = String(cause)
    console.error('[local-ipc] request failed', {
      method,
      paramsKeys: Object.keys(params ?? {}),
      error: error.length > 1_000 ? `${error.slice(0, 1_000)}…` : error,
      message: (cause as { message?: unknown } | null)?.message ?? null,
      stack: (cause as { stack?: unknown } | null)?.stack ?? null,
    })
    throw cause
  })
}

export function subscribeLocalExecutorEvents(
  handler: (event: LocalExecutorEvent) => void
): Promise<UnlistenFn> {
  return listen<LocalExecutorEvent>(LOCAL_EXECUTOR_EVENT, event => {
    handler(event.payload)
  })
}
