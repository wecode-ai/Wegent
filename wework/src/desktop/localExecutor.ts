import {
  DshExecutorTransportError,
  describeDshExecutor,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from '@/api/dsh/executorTransport'
import { getLocalProxyUrl } from '@/features/model-settings/localProxySettings'

export type UnlistenFn = () => void

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
  transport: 'stdio' | 'dsh-http'
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
  sequence?: number
}

interface CodexStartupStatus {
  ready: boolean
  started: boolean
  initializeElapsedMs: number
}

export interface LocalExecutorBackendConnection {
  backendUrl: string
  socketBaseUrl: string
  authToken: string
  runtimeAuthToken?: string | null
  deviceType: 'app' | 'remote'
}

interface LocalExecutorBackendStatus {
  configured: boolean
  connected: boolean
  backend_url: string | null
  socket_url: string | null
}

export interface BundledPluginMarketplace {
  id: string
  path: string
  pluginCount: number
  defaultPluginNames?: string[]
  contentHash: string
}

let ensureLocalExecutorAvailablePromise: Promise<LocalExecutorStatus> | null = null
let ensureLocalExecutorStartedPromise: Promise<LocalExecutorStatus> | null = null
let availableLocalExecutorStatus: LocalExecutorStatus | null = null
let initializedLocalExecutorStatus: LocalExecutorStatus | null = null
let initializedBundledPluginMarketplace: BundledPluginMarketplace | null = null
let initializeBundledPluginMarketplacePromise: Promise<BundledPluginMarketplace> | null = null
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
  const response = await requestLocalExecutor<{
    config: { plugins?: Record<string, unknown> | null }
  }>('codex.app_server_request', {
    method: 'config/read',
    params: {
      includeLayers: false,
      cwd: null,
    },
  })
  const configuredPluginKeys = new Set(Object.keys(response.config.plugins ?? {}))
  for (const pluginName of defaultPluginNames) {
    if (configuredPluginKeys.has(`${pluginName}@${marketplace.id}`)) continue
    // The local path identifies the bundled catalog. Codex resolves each
    // plugin entry's declared source, which may itself be local or remote.
    await requestLocalExecutor('codex.app_server_request', {
      method: 'plugin/install',
      params: {
        marketplacePath: bundledMarketplaceManifestPath(marketplace.path),
        remoteMarketplaceName: null,
        pluginName,
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
    marketplace.contentHash,
  ].join(':')
  if (reconciledBundledPluginMarketplaceKey === reconciliationKey) return

  const addMarketplace = () =>
    requestLocalExecutor<{ marketplaceName: string }>('codex.app_server_request', {
      method: 'marketplace/add',
      params: {
        source: marketplace.path,
        refName: null,
        sparsePaths: null,
      },
    })

  let added: { marketplaceName: string }
  try {
    added = await addMarketplace()
  } catch (addError) {
    const available = await requestLocalExecutor<{
      marketplaces: Array<{ name: string; path?: string | null }>
    }>('codex.app_server_request', {
      method: 'plugin/list',
      params: {
        cwds: null,
        marketplaceKinds: ['local'],
      },
    })
    const existing = available.marketplaces.find(candidate => candidate.name === marketplace.id)
    if (!existing) {
      throw new Error(`Bundled plugin marketplace ${marketplace.id} could not be registered`, {
        cause: addError,
      })
    }
    await requestLocalExecutor('codex.app_server_request', {
      method: 'marketplace/remove',
      params: { marketplaceName: marketplace.id },
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
    marketplace.contentHash,
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
  const marketplace =
    initializedBundledPluginMarketplace ?? (await initializeBundledPluginMarketplace())
  if (!marketplace?.defaultPluginNames?.includes(normalizedPluginName)) {
    throw new Error(`Bundled plugin ${normalizedPluginName} is not installed by default`)
  }
  await ensureBundledPluginMarketplaceRegistered()
}

export function getInitializedBundledPluginMarketplace(): BundledPluginMarketplace | null {
  return initializedBundledPluginMarketplace
}

export function ensureLocalExecutorAvailable(): Promise<LocalExecutorStatus> {
  if (availableLocalExecutorStatus && isExecutorHealthy(availableLocalExecutorStatus)) {
    return Promise.resolve(availableLocalExecutorStatus)
  }
  if (!ensureLocalExecutorAvailablePromise) {
    ensureLocalExecutorAvailablePromise = describeDshExecutor()
      .then(description => {
        const status: LocalExecutorStatus = {
          running: true,
          ready: true,
          deviceId: description.device_id,
          runtimeInstanceId: description.runtime_instance_id,
          version: description.version,
        }
        availableLocalExecutorStatus = status
        return status
      })
      .finally(() => {
        ensureLocalExecutorAvailablePromise = null
      })
  }
  return ensureLocalExecutorAvailablePromise
}

export function initializeBundledPluginMarketplace(): Promise<BundledPluginMarketplace> {
  if (initializedBundledPluginMarketplace) {
    return Promise.resolve(initializedBundledPluginMarketplace)
  }
  if (!initializeBundledPluginMarketplacePromise) {
    initializeBundledPluginMarketplacePromise = ensureLocalExecutorAvailable()
      .then(() =>
        requestDshExecutor<BundledPluginMarketplace>(
          'executor.plugins.initialize_bundled_marketplace'
        )
      )
      .then(marketplace => {
        initializedBundledPluginMarketplace = marketplace
        return marketplace
      })
      .finally(() => {
        initializeBundledPluginMarketplacePromise = null
      })
  }
  return initializeBundledPluginMarketplacePromise
}

export function ensureLocalExecutorStarted(): Promise<LocalExecutorStatus> {
  if (initializedLocalExecutorStatus && isExecutorHealthy(initializedLocalExecutorStatus)) {
    return Promise.resolve(initializedLocalExecutorStatus)
  }
  if (!ensureLocalExecutorStartedPromise) {
    ensureLocalExecutorStartedPromise = (async () => {
      const available = await ensureLocalExecutorAvailable()
      const proxyUrl = getLocalProxyUrl().trim()
      await requestDshExecutor('runtime.codex.runtime_config.update', {
        proxyUrl: proxyUrl || null,
      })
      const codexStartup = await requestDshExecutor<CodexStartupStatus>(
        'runtime.codex.ensure_started'
      )
      await initializeBundledPluginMarketplace()
      const status: LocalExecutorStatus = {
        ...available,
        ready: codexStartup.ready,
        codexInitializeElapsedMs: codexStartup.initializeElapsedMs,
      }
      initializedLocalExecutorStatus = status
      availableLocalExecutorStatus = status
      return status
    })().finally(() => {
      ensureLocalExecutorStartedPromise = null
    })
  }

  return ensureLocalExecutorStartedPromise
}

export function resetLocalExecutorStateForTests(): void {
  ensureLocalExecutorAvailablePromise = null
  ensureLocalExecutorStartedPromise = null
  availableLocalExecutorStatus = null
  initializedLocalExecutorStatus = null
  initializedBundledPluginMarketplace = null
  initializeBundledPluginMarketplacePromise = null
  reconciledBundledPluginMarketplaceKey = ''
  reconcilingBundledPluginMarketplaceKey = ''
  reconcileBundledPluginMarketplacePromise = null
}

export function getLocalExecutorStatus(): Promise<LocalExecutorStatus> {
  return ensureLocalExecutorAvailable()
}

export async function readLocalExecutorLog(): Promise<LocalExecutorLog> {
  const [status, backendStatus] = await Promise.all([
    ensureLocalExecutorAvailable(),
    requestDshExecutor<LocalExecutorBackendStatus>('executor.backend.status', {}),
  ])
  return {
    path: 'Electron managed executor log',
    content: 'Executor diagnostics are managed by the Electron runtime.',
    truncated: false,
    lineCount: 1,
    transport: 'dsh-http',
    transportConnected: true,
    processPids: [],
    processPaths: [],
    sidecarSource: 'electron-managed',
    sidecarPath: '',
    currentDir: '',
    executorHome: '',
    backendUrl: backendStatus.backend_url,
    socketUrl: backendStatus.socket_url,
    hasBackendAuthToken: backendStatus.configured,
    pendingRequestCount: 0,
    status,
  }
}

export function copyLocalExecutorDebugInfo(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
  }
  return Promise.reject(new Error('Clipboard API is unavailable'))
}

export function connectLocalExecutorToBackend(
  connection: LocalExecutorBackendConnection
): Promise<LocalExecutorStatus> {
  return requestDshExecutor('executor.backend.configure', {
    backend_url: connection.backendUrl,
    socket_url: connection.socketBaseUrl,
    auth_token: connection.authToken,
    runtime_auth_token: connection.runtimeAuthToken ?? null,
    device_type: connection.deviceType,
  }).then(() => ensureLocalExecutorAvailable())
}

export function disconnectLocalExecutorFromBackend(): Promise<LocalExecutorStatus> {
  return requestDshExecutor('executor.backend.configure', {}).then(() =>
    ensureLocalExecutorAvailable()
  )
}

export function requestLocalExecutor<T = unknown>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return requestDshExecutor<T>(method, params).catch((cause: unknown) => {
    if (isExecutorTransportFailure(cause)) {
      availableLocalExecutorStatus = null
      initializedLocalExecutorStatus = null
      initializedBundledPluginMarketplace = null
      initializeBundledPluginMarketplacePromise = null
      reconciledBundledPluginMarketplaceKey = ''
    }
    console.error('[local-ipc] request failed', {
      method,
      paramsKeys: Object.keys(params ?? {}),
      error: String(cause),
      message: (cause as { message?: unknown } | null)?.message ?? null,
      stack: (cause as { stack?: unknown } | null)?.stack ?? null,
    })
    throw cause
  })
}

function isExecutorTransportFailure(cause: unknown): boolean {
  if (!(cause instanceof DshExecutorTransportError)) return true
  return cause.retryable || cause.code === 'protocol_mismatch' || /^http_\d+$/.test(cause.code)
}

export function subscribeLocalExecutorEvents(
  handler: (event: LocalExecutorEvent) => void
): Promise<UnlistenFn> {
  return Promise.resolve(
    subscribeDshExecutorEvents(event => {
      handler({ event: event.event, payload: event.payload, sequence: event.sequence })
    })
  )
}
