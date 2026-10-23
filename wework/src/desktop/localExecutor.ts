import type { RuntimeEvent as LocalExecutorEvent } from '@wegent/chat-core'
import { readRuntimeTranscript } from '@wegent/chat-core'
import {
  DshExecutorTransportError,
  describeDshExecutor,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from '@/api/dsh/executorTransport'
import { resolveLocalCodexProxyUrl } from './systemProxy'
import { createModelLoadingTrace, traceModelLoading } from '@/lib/model-loading-diagnostics'

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

export type { RuntimeEvent as LocalExecutorEvent } from '@wegent/chat-core'

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
let localExecutorIdentityEpoch = 0
let availableLocalExecutorStatus: LocalExecutorStatus | null = null
let initializedLocalExecutorStatus: LocalExecutorStatus | null = null
let initializedBundledPluginMarketplace: BundledPluginMarketplace | null = null
let initializeBundledPluginMarketplacePromise: Promise<BundledPluginMarketplace> | null = null
let reconciledBundledPluginMarketplaceKey = ''
let reconcilingBundledPluginMarketplaceKey = ''
let reconcileBundledPluginMarketplacePromise: Promise<void> | null = null
export interface BundledPluginUpdateState {
  status: 'updating' | 'ready' | 'deferred' | 'failed'
  error?: string
}
const bundledPluginUpdates = new Map<string, BundledPluginUpdateState>()
const bundledPluginUpdateTasks = new Map<string, Promise<void>>()
const pausedBundledPluginUpdates = new Set<string>()
const bundledPluginUpdateListeners = new Set<() => void>()
let bundledPluginRetryListener: UnlistenFn | null = null
let bundledPluginRetryTimer: ReturnType<typeof setTimeout> | null = null
let bundledPluginUpdateEpoch = 0
export const BUNDLED_PLUGIN_UPDATED_EVENT = 'wework:local-plugin-skills-changed'

export function getBundledPluginUpdateState(name: string): BundledPluginUpdateState | undefined {
  return bundledPluginUpdates.get(name)
}

export function subscribeBundledPluginUpdates(listener: () => void): UnlistenFn {
  bundledPluginUpdateListeners.add(listener)
  return () => bundledPluginUpdateListeners.delete(listener)
}

function setBundledPluginUpdateState(name: string, state: BundledPluginUpdateState): void {
  bundledPluginUpdates.set(name, state)
  for (const listener of bundledPluginUpdateListeners) listener()
}

export async function withBundledPluginUpdatesPaused<T>(
  name: string,
  mutation: () => Promise<T>
): Promise<T> {
  const wasPaused = pausedBundledPluginUpdates.has(name)
  const previousState = bundledPluginUpdates.get(name)
  pausedBundledPluginUpdates.add(name)
  bundledPluginUpdates.delete(name)
  for (const listener of bundledPluginUpdateListeners) listener()
  // Let any admitted file mutation finish before deleting its cache/configuration.
  await bundledPluginUpdateTasks.get(name)?.catch(() => undefined)
  try {
    return await mutation()
  } catch (error) {
    if (!wasPaused) {
      pausedBundledPluginUpdates.delete(name)
      if (previousState) {
        setBundledPluginUpdateState(name, { status: 'deferred' })
        scheduleDeferredBundledPlugins()
      }
    }
    throw error
  }
}

export function resumeBundledPluginUpdates(name: string): void {
  if (!pausedBundledPluginUpdates.delete(name)) return
  bundledPluginUpdates.delete(name)
  for (const listener of bundledPluginUpdateListeners) listener()
}

async function synchronizeBundledPlugin(
  name: string,
  marketplace: BundledPluginMarketplace
): Promise<void> {
  if (pausedBundledPluginUpdates.has(name)) return
  const pending = bundledPluginUpdateTasks.get(name)
  if (pending) return pending
  const epoch = bundledPluginUpdateEpoch
  setBundledPluginUpdateState(name, { status: 'updating' })
  const task = requestLocalExecutor<{ status: 'ready' | 'deferred'; updated: boolean }>(
    'runtime.codex.plugin.sync_bundled',
    { pluginName: name, marketplacePath: bundledMarketplaceManifestPath(marketplace.path) }
  )
    .then(result => {
      if (epoch !== bundledPluginUpdateEpoch || pausedBundledPluginUpdates.has(name)) return
      setBundledPluginUpdateState(name, { status: result.status })
      if (result.status === 'deferred') scheduleDeferredBundledPlugins()
      if (result.updated) window.dispatchEvent(new Event(BUNDLED_PLUGIN_UPDATED_EVENT))
    })
    .catch((error: unknown) => {
      if (epoch === bundledPluginUpdateEpoch && !pausedBundledPluginUpdates.has(name)) {
        setBundledPluginUpdateState(name, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      throw error
    })
    .finally(() => {
      if (bundledPluginUpdateTasks.get(name) === task) bundledPluginUpdateTasks.delete(name)
    })
  bundledPluginUpdateTasks.set(name, task)
  return task
}

function watchDeferredBundledPlugins(): void {
  if (bundledPluginRetryListener) return
  bundledPluginRetryListener = subscribeDshExecutorEvents(event => {
    if (event.event === 'runtime.work.changed') scheduleDeferredBundledPlugins()
  })
}

function scheduleDeferredBundledPlugins(): void {
  if (
    bundledPluginRetryTimer ||
    ![...bundledPluginUpdates.values()].some(state => state.status === 'deferred')
  )
    return
  bundledPluginRetryTimer = setTimeout(() => {
    bundledPluginRetryTimer = null
    const marketplace = initializedBundledPluginMarketplace
    if (!marketplace) return
    for (const [name, state] of bundledPluginUpdates) {
      if (state.status === 'deferred') {
        void synchronizeBundledPlugin(name, marketplace).catch(error =>
          console.warn('[local-ipc] bundled plugin update failed', error)
        )
      }
    }
  }, 2_000)
}
let nextLocalExecutorRequestFailure: {
  method: string
  message: string
  resolve: () => void
} | null = null

type LocalExecutorRequestHold = {
  method: string
  phase: 'before-dispatch' | 'after-response'
  heldCount: number
  completedCount: number
  enteredWaiters: Array<() => void>
  releaseWaiters: Array<() => void>
  released: boolean
}

let localExecutorRequestHold: LocalExecutorRequestHold | null = null

function isLocalExecutorE2EMode(): boolean {
  return import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true'
}

export function failNextLocalExecutorRequestForE2E(method: string, message: string): Promise<void> {
  if (!isLocalExecutorE2EMode()) {
    throw new Error('Local executor request failure injection is only available in E2E mode')
  }
  return new Promise(resolve => {
    nextLocalExecutorRequestFailure = { method, message, resolve }
  })
}

/**
 * Holds E2E requests either before dispatch or after the real executor replied.
 * The caller observes the response only after the ordering gate opens.
 */
export function holdLocalExecutorRequestsForE2E(
  method: string,
  phase: LocalExecutorRequestHold['phase'] = 'after-response'
): void {
  if (!isLocalExecutorE2EMode()) {
    throw new Error('Local executor request holds are only available in E2E mode')
  }
  localExecutorRequestHold = {
    method,
    phase,
    heldCount: 0,
    completedCount: 0,
    enteredWaiters: [],
    releaseWaiters: [],
    released: false,
  }
}

export function awaitLocalExecutorRequestHoldForE2E(): Promise<number> {
  const hold = localExecutorRequestHold
  if (!hold) return Promise.resolve(0)
  if (hold.heldCount > 0 || hold.released) return Promise.resolve(hold.heldCount)
  return new Promise(resolve => {
    hold.enteredWaiters.push(() => resolve(hold.heldCount))
  })
}

export function releaseLocalExecutorRequestHoldForE2E(): boolean {
  const hold = localExecutorRequestHold
  if (!hold || hold.released) return false
  hold.released = true
  for (const release of hold.releaseWaiters.splice(0)) release()
  return true
}

export function getLocalExecutorRequestHoldSnapshotForE2E(): {
  method: string
  phase: LocalExecutorRequestHold['phase']
  heldCount: number
  completedCount: number
  released: boolean
} | null {
  const hold = localExecutorRequestHold
  if (!hold) return null
  return {
    method: hold.method,
    phase: hold.phase,
    heldCount: hold.heldCount,
    completedCount: hold.completedCount,
    released: hold.released,
  }
}

function isExecutorHealthy(status: LocalExecutorStatus): boolean {
  return status.running && status.ready !== false && !status.error
}

function ensureLocalExecutorIdentityUnchanged(epoch: number): void {
  if (epoch !== localExecutorIdentityEpoch) {
    throw new DshExecutorTransportError(
      'protocol_mismatch',
      'Executor identity was revoked while checking executor readiness'
    )
  }
}

function markLocalExecutorUnavailable(cause: unknown): void {
  if (cause instanceof DshExecutorTransportError && cause.code === 'protocol_mismatch') {
    localExecutorIdentityEpoch += 1
    availableLocalExecutorStatus = null
  } else if (availableLocalExecutorStatus) {
    availableLocalExecutorStatus = {
      ...availableLocalExecutorStatus,
      running: false,
      ready: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
  initializedLocalExecutorStatus = null
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
  watchDeferredBundledPlugins()
  const results = await Promise.allSettled(
    defaultPluginNames.map(name => synchronizeBundledPlugin(name, marketplace))
  )
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected')
    console.warn('[local-ipc] bundled plugin update failed', failure.reason)
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
  const reconciled = await requestLocalExecutor<{ marketplaceName: string; action: string }>(
    'runtime.codex.plugin.reconcile_bundled_marketplace',
    {
      marketplaceId: marketplace.id,
      source: marketplace.path,
    }
  )
  if (reconciled.marketplaceName !== marketplace.id) {
    throw new Error(
      `Bundled plugin marketplace resolved to ${reconciled.marketplaceName || 'an unknown name'}`
    )
  }
  void installBundledMarketplaceDefaults(marketplace).catch(error => {
    console.warn('[local-ipc] bundled plugin updates failed', error)
  })
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
  if (pausedBundledPluginUpdates.has(normalizedPluginName)) {
    throw new DshExecutorTransportError(
      'bundled_plugin_uninstalled',
      'Codex plugin is not installed'
    )
  }
  const current = bundledPluginUpdates.get(normalizedPluginName)?.status
  if (current !== 'ready' && current !== 'deferred') {
    await synchronizeBundledPlugin(normalizedPluginName, marketplace)
  }
  if (pausedBundledPluginUpdates.has(normalizedPluginName)) {
    throw new DshExecutorTransportError(
      'bundled_plugin_uninstalled',
      'Codex plugin is not installed'
    )
  }
  if (bundledPluginUpdates.get(normalizedPluginName)?.status !== 'ready') {
    throw new DshExecutorTransportError(
      'bundled_plugin_update_deferred',
      'Bundled plugin update is waiting for active work to finish'
    )
  }
}

export function getInitializedBundledPluginMarketplace(): BundledPluginMarketplace | null {
  return initializedBundledPluginMarketplace
}

export function getKnownLocalExecutorDeviceId(): string | null {
  return (
    initializedLocalExecutorStatus?.deviceId?.trim() ||
    availableLocalExecutorStatus?.deviceId?.trim() ||
    null
  )
}

export function ensureLocalExecutorAvailable(
  options: { refresh?: boolean } = {}
): Promise<LocalExecutorStatus> {
  if (
    !options.refresh &&
    availableLocalExecutorStatus &&
    isExecutorHealthy(availableLocalExecutorStatus)
  ) {
    return Promise.resolve(availableLocalExecutorStatus)
  }
  if (options.refresh || !ensureLocalExecutorAvailablePromise) {
    const epoch = localExecutorIdentityEpoch
    const availability = describeDshExecutor()
      .then(description => {
        ensureLocalExecutorIdentityUnchanged(epoch)
        if (
          availableLocalExecutorStatus &&
          (availableLocalExecutorStatus.runtimeInstanceId !== description.runtime_instance_id ||
            availableLocalExecutorStatus.deviceId !== description.device_id)
        ) {
          localExecutorIdentityEpoch += 1
          initializedLocalExecutorStatus = null
          ensureLocalExecutorStartedPromise = null
        }
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
      .catch((cause: unknown) => {
        if (epoch === localExecutorIdentityEpoch) markLocalExecutorUnavailable(cause)
        throw cause
      })
      .finally(() => {
        if (ensureLocalExecutorAvailablePromise === availability)
          ensureLocalExecutorAvailablePromise = null
      })
    ensureLocalExecutorAvailablePromise = availability
  }
  return ensureLocalExecutorAvailablePromise
}

export function initializeBundledPluginMarketplace(): Promise<BundledPluginMarketplace> {
  if (initializedBundledPluginMarketplace) {
    return Promise.resolve(initializedBundledPluginMarketplace)
  }
  if (!initializeBundledPluginMarketplacePromise) {
    const epoch = bundledPluginUpdateEpoch
    const initialization = ensureLocalExecutorAvailable()
      .then(() =>
        requestDshExecutor<BundledPluginMarketplace>(
          'executor.plugins.initialize_bundled_marketplace'
        )
      )
      .then(marketplace => {
        if (epoch !== bundledPluginUpdateEpoch) {
          throw new DshExecutorTransportError(
            'bundled_plugin_runtime_changed',
            'Executor changed while preparing bundled plugins'
          )
        }
        initializedBundledPluginMarketplace = marketplace
        return marketplace
      })
      .finally(() => {
        if (initializeBundledPluginMarketplacePromise === initialization)
          initializeBundledPluginMarketplacePromise = null
      })
    initializeBundledPluginMarketplacePromise = initialization
  }
  return initializeBundledPluginMarketplacePromise
}

export function ensureLocalExecutorStarted(): Promise<LocalExecutorStatus> {
  if (initializedLocalExecutorStatus && isExecutorHealthy(initializedLocalExecutorStatus)) {
    return Promise.resolve(initializedLocalExecutorStatus)
  }
  if (!ensureLocalExecutorStartedPromise) {
    const epoch = localExecutorIdentityEpoch
    const traceId = createModelLoadingTrace()
    const startup = (async () => {
      const available = await traceModelLoading(
        traceId,
        'executor.available',
        ensureLocalExecutorAvailable
      )
      const proxyUrl = await traceModelLoading(traceId, 'executor.proxy', resolveLocalCodexProxyUrl)
      await traceModelLoading(traceId, 'executor.runtime_config', () =>
        requestDshExecutor('runtime.codex.runtime_config.update', { proxyUrl })
      )
      const codexStartup = await traceModelLoading(traceId, 'executor.codex_start', () =>
        requestDshExecutor<CodexStartupStatus>('runtime.codex.ensure_started')
      )
      ensureLocalExecutorIdentityUnchanged(epoch)
      const status: LocalExecutorStatus = {
        ...available,
        ready: codexStartup.ready,
        codexInitializeElapsedMs: codexStartup.initializeElapsedMs,
      }
      initializedLocalExecutorStatus = status
      availableLocalExecutorStatus = status
      // Bundled default plugins must reach the Codex plugins cache even when no
      // renderer ever opens the app/plugin catalog (e.g. isolated plugin
      // development instances). Reconcile is local-only: it reads the bundled
      // marketplace from disk and never contacts GitHub.
      void initializeBundledPluginMarketplace()
        .then(() => ensureBundledPluginMarketplaceRegistered())
        .catch(error => {
          console.warn('[local-ipc] bundled plugin marketplace reconcile failed', error)
        })
      return status
    })().finally(() => {
      if (ensureLocalExecutorStartedPromise === startup) ensureLocalExecutorStartedPromise = null
    })
    ensureLocalExecutorStartedPromise = startup
  }

  return ensureLocalExecutorStartedPromise
}

export function resetLocalExecutorStateForTests(): void {
  localExecutorIdentityEpoch += 1
  bundledPluginUpdateEpoch += 1
  bundledPluginRetryListener?.()
  bundledPluginRetryListener = null
  if (bundledPluginRetryTimer) clearTimeout(bundledPluginRetryTimer)
  bundledPluginRetryTimer = null
  bundledPluginUpdates.clear()
  bundledPluginUpdateTasks.clear()
  pausedBundledPluginUpdates.clear()
  ensureLocalExecutorAvailablePromise = null
  ensureLocalExecutorStartedPromise = null
  availableLocalExecutorStatus = null
  initializedLocalExecutorStatus = null
  initializedBundledPluginMarketplace = null
  initializeBundledPluginMarketplacePromise = null
  reconciledBundledPluginMarketplaceKey = ''
  reconcilingBundledPluginMarketplaceKey = ''
  reconcileBundledPluginMarketplacePromise = null
  localExecutorRequestHold = null
  nextLocalExecutorRequestFailure = null
}

export function getLocalExecutorStatus(): Promise<LocalExecutorStatus> {
  return ensureLocalExecutorAvailable().catch((cause: unknown) => {
    if (availableLocalExecutorStatus) return availableLocalExecutorStatus
    throw cause
  })
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
  const dispatch = (): Promise<T> => {
    if (nextLocalExecutorRequestFailure?.method === method) {
      const failure = nextLocalExecutorRequestFailure
      nextLocalExecutorRequestFailure = null
      failure.resolve()
      return Promise.reject(new Error(failure.message))
    }
    const request =
      method === 'runtime.tasks.transcript' && params.transcriptProtocolVersion === undefined
        ? readRuntimeTranscript<T>(params, query => requestDshExecutor(method, query))
        : requestDshExecutor<T>(method, params)
    return request.catch((cause: unknown) => {
      if (isExecutorTransportFailure(cause)) {
        bundledPluginUpdateEpoch += 1
        bundledPluginUpdateTasks.clear()
        bundledPluginUpdates.clear()
        markLocalExecutorUnavailable(cause)
        initializedBundledPluginMarketplace = null
        initializeBundledPluginMarketplacePromise = null
        reconciledBundledPluginMarketplaceKey = ''
      }
      console.error(
        '[local-ipc] request failed',
        JSON.stringify({
          method,
          paramsKeys: Object.keys(params ?? {}),
          error: String(cause),
          message: (cause as { message?: unknown } | null)?.message ?? null,
          stack: (cause as { stack?: unknown } | null)?.stack ?? null,
        })
      )
      throw cause
    })
  }
  const hold = localExecutorRequestHold
  if (!hold || hold.method !== method || hold.released) return dispatch()
  const enterHold = () => {
    hold.heldCount += 1
    for (const notify of hold.enteredWaiters.splice(0)) notify()
    if (hold.released) return Promise.resolve()
    return new Promise<void>(resolve => hold.releaseWaiters.push(resolve))
  }
  if (hold.phase === 'before-dispatch') {
    return enterHold()
      .then(dispatch)
      .finally(() => {
        hold.completedCount += 1
      })
  }
  return dispatch().then(async value => {
    await enterHold()
    hold.completedCount += 1
    return value
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
