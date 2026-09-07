import './host/process-output-bootstrap.js'

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  shell,
  Tray,
  webContents,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type WebContents,
} from 'electron'
import electronUpdater from 'electron-updater'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  captureWebContentsDataUrl,
  createElectronCapabilityRouter,
} from './host/electron-capabilities.js'
import { HostPipeServer } from './host/host-pipe.js'
import { DesktopHostEventBroker } from './host/desktop-host-events.js'
import { requiresMacosQuitWorkaround } from './host/macos-quit-workaround.js'
import { RendererHealthService } from './host/renderer-health.js'
import { SmartAppManager, type SmartAppRuntimeHost } from './host/smart-app-manager.js'
import { SystemSleepController } from './host/system-sleep-controller.js'
import { PreferencesStore } from './host/preferences-store.js'
import { RendererStorageStore } from './host/renderer-storage-store.js'
import {
  EMBEDDED_BROWSER_PARTITION,
  EMBEDDED_BROWSER_ROUTE_HOST_SEPARATOR,
  EMBEDDED_BROWSER_ROUTE_PARTITION_PREFIX,
  EmbeddedBrowserManager,
} from './host/embedded-browser-manager.js'
import { EmbeddedBrowserBridge } from './host/embedded-browser-bridge.js'
import { WeworkDesktopControlBridge } from './host/wework-desktop-control-bridge.js'
import { ComputerUseService } from './host/computer-use-service.js'
import { restoreComputerUseAfterStartup } from './host/computer-use-startup.js'
import { materializeBundledRuntimes } from './runtime/bundled-runtime-materializer.js'
import { waitForRendererSelector } from './host/renderer-readiness.js'
import { desktopWindowFrameOptions } from './host/window-layout.js'
import { createSingleFlight, presentWindow } from './host/window-presentation.js'
import { DesktopRuntime } from './runtime/desktop-runtime.js'
import { FeedbackBundleManager } from './host/feedback-bundle-manager.js'
import {
  resolveStartupSplashTheme,
  StartupSplash,
  startupSplashBlocksMainWindowActivation,
  type StartupSplashTheme,
} from './host/startup-splash.js'
import { assertStartupRecoverySender, StartupRecoveryService } from './host/startup-recovery.js'
import { ElectronTrayManager, type TrayAction } from './host/tray-manager.js'
import { createTrayIcon } from './host/tray-icon.js'
import { trayGuidForApplicationId } from './host/tray-guid.js'
import { TrayNativeStatusController } from './host/tray-native-status.js'
import { WindowClosePolicy, type WindowCloseDecision } from './host/window-close-policy.js'
import { AppUpdateService } from './host/app-update-service.js'
import { AppUpdateLogger } from './host/app-update-logger.js'
import { CloudCredentialError, CloudCredentialService } from './host/cloud-credential-service.js'
import {
  cleanupStaleTemporaryImages,
  createNativeContextMenuActions,
  installContextMenu,
} from './host/image-context-actions.js'
import { SystemResumeBridge } from './host/system-resume-bridge.js'
import {
  prepareDesktopComponents,
  shouldStageDesktopComponentUpdates,
  type DesktopComponentUpdateController,
} from './runtime/desktop-components.js'
import {
  prepareElectronNodeRuntime,
  resolveConfiguredNodePath,
  type ElectronNodeRuntime,
} from './runtime/electron-node-runtime.js'
import {
  applyBrandRuntimeEnvironment,
  type BrandRuntimeMetadata,
} from './runtime/brand-runtime-environment.js'
import { keepDesktopE2EInBackground } from './host/e2e-window-policy.js'
import { GlobalShortcutController } from './host/global-shortcut-controller.js'
import { resolveDshAppRoute } from './host/dsh-app-route.js'
import { BrowserAnnotationController } from './host/browser-annotation-controller.js'
import { LogRetentionService, type LogCleanupResult } from './runtime/log-retention.js'
import {
  PluginDevelopmentManager,
  pluginDevelopmentElectronArguments,
} from './runtime/plugin-development-manager.js'
import { PluginDevelopmentChildRuntime } from './runtime/plugin-development-child-runtime.js'
import {
  canReplaceWeworkCli,
  installWeworkCli,
  shouldInstallUserWeworkCli,
} from './runtime/wework-cli-installer.js'
import {
  parseLocalWorkspaceOpenRequest,
  type LocalWorkspaceOpenRequest,
} from './runtime/local-workspace-cli.js'
import { SecureValueStore } from './host/secure-value-store.js'
import { resolveDevelopmentDockIdentity } from './host/development-dock-identity.js'
import { isEffectivePackagedApplication } from './host/application-packaging-mode.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageMetadata = createRequire(import.meta.url)('../package.json') as {
  weworkAppId?: string
  weworkUpdateBaseUrl?: string
} & BrandRuntimeMetadata
const dshPreloadPath = resolve(packageRoot, 'dist/dsh-preload.cjs')
const startupSplashPreloadPath = resolve(packageRoot, 'dist/startup-splash-preload.cjs')
const browserAnnotationPreloadPath = resolve(packageRoot, 'dist/browser-annotation-preload.cjs')
const developmentResourcesRoot = resolve(packageRoot, '..', 'resources')
const { autoUpdater } = electronUpdater
const execFileAsync = promisify(execFile)
const keepE2EWindowInBackground = keepDesktopE2EInBackground(process.env, process.platform)
const updateBaseUrl =
  process.env.WEWORK_UPDATE_BASE_URL?.trim() ||
  packageMetadata.weworkUpdateBaseUrl?.trim() ||
  'https://github.com/wecode-ai/Wegent/releases/download/wework-updater'
const applicationId =
  process.env.WEWORK_APP_IDENTIFIER?.trim() ||
  packageMetadata.weworkAppId?.trim() ||
  'io.wecode.wework'
const developmentDockIdentity = resolveDevelopmentDockIdentity(process.env)
const packagedApplication = isEffectivePackagedApplication(app.isPackaged, process.env)
const DEFAULT_POPOUT_WINDOW_SHORTCUT = 'Alt+Shift+Space'
const startupStartedAt = performance.now()
const pluginDevelopmentInstance = process.env.WEWORK_INSTANCE_MODE === 'core-dsh-plugin-development'
const pluginDevelopmentCommand = commandLineValue(
  process.argv,
  '--wework-plugin-development-command'
)
const startupWorkspaceOpenRequest = parseLocalWorkspaceOpenRequest(process.argv)

if (developmentDockIdentity) process.title = developmentDockIdentity.displayName

function logStartupStep(
  step: string,
  status: 'started' | 'completed' | 'failed',
  details: Record<string, unknown> = {}
): void {
  console.info('[startup]', {
    step,
    status,
    elapsedMs: Math.round(performance.now() - startupStartedAt),
    ...details,
  })
}

function commandLineValue(argv: string[], name: string): string | null {
  const index = argv.lastIndexOf(name)
  const value = index >= 0 ? argv[index + 1]?.trim() : ''
  return value || null
}

const configuredUserDataPath = process.env.WEWORK_USER_DATA_DIR?.trim()
const userDataPath = resolve(configuredUserDataPath || join(app.getPath('appData'), applicationId))
app.setPath('userData', userDataPath)
if (configuredUserDataPath) app.setAppLogsPath(join(userDataPath, 'logs'))

let mainWindow: BrowserWindow | null = null
let startupSplashWindow: BrowserWindow | null = null
const workspaceWindows = new Map<string, BrowserWindow>()
const dshWindowLabels = new Map<number, string>()
let primaryDshLoaded = false
let primaryDshSecurityInstalled = false
let desktopRuntime: DesktopRuntime | null = null
let smartApps: SmartAppManager | null = null
let embeddedBrowser: EmbeddedBrowserManager | null = null
let embeddedBrowserBridge: EmbeddedBrowserBridge | null = null
let desktopControlBridge: WeworkDesktopControlBridge | null = null
let browserAnnotations: BrowserAnnotationController | null = null
let computerUse: ComputerUseService | null = null
let systemDragWindow: BrowserWindow | null = null
let pendingSystemDragWindow: BrowserWindow | null = null
let systemDragWindowCreationPromise: Promise<BrowserWindow> | null = null
let popoutWindow: BrowserWindow | null = null
let popoutWindowCreationPromise: Promise<BrowserWindow> | null = null
let popoutWindowReadyPromise: Promise<void> | null = null
let popoutShortcut: GlobalShortcutController | null = null
let systemDragContext: { conversationTitle: string | null } = { conversationTitle: null }
let pendingSystemDrops: Array<{
  action: 'new-chat' | 'follow-up' | 'stash'
  text: string | null
  paths: string[]
}> = []
let runtimeError: string | null = null
let runtimePhase: 'initializing' | 'ready' | 'failed' = 'initializing'
let runtimeStartPromise: Promise<void> | null = null
let computerUseStartupScheduled = false
let electronNodeRuntimePromise: Promise<ElectronNodeRuntime> | null = null
let quitting = false
let shutdownPromise: Promise<void> | null = null
let dockVisible = true
let e2eForegroundActivationAllowed = false
let preferences: PreferencesStore | null = null
let rendererStorage: RendererStorageStore | null = null
let cloudCredentials: CloudCredentialService | null = null
let windowClosePolicy: WindowClosePolicy | null = null
let startupSplash: StartupSplash | null = null
let startupRecovery: StartupRecoveryService | null = null
let componentUpdates: DesktopComponentUpdateController | null = null
let pluginDevelopment: PluginDevelopmentManager | null = null
const pluginDevelopmentChildRuntime =
  pluginDevelopmentInstance &&
  process.env.WEWORK_PLUGIN_DEVELOPMENT_STATE_PATH?.trim() &&
  process.env.WEWORK_PLUGIN_DEVELOPMENT_ROOT?.trim()
    ? new PluginDevelopmentChildRuntime({
        statePath: process.env.WEWORK_PLUGIN_DEVELOPMENT_STATE_PATH.trim(),
        sourceRoot: process.env.WEWORK_PLUGIN_DEVELOPMENT_ROOT.trim(),
        focus: reactivateMainWindow,
        openDevTools: () =>
          mainWindow?.webContents.openDevTools({ mode: 'detach', activate: true }),
        restartCoreDsh: restartPrimaryCoreDsh,
        requestStop: () => requestApplicationShutdown(() => app.quit()),
        getCoreDshPid: () => desktopRuntime?.diagnostics().coreDshPid ?? null,
        isShuttingDown: () => quitting || !desktopRuntime,
      })
    : null
let trayManager: ElectronTrayManager<Electron.Menu | null, Tray> | null = null
let trayNativeStatus: TrayNativeStatusController | null = null
const desktopHostEvents = new DesktopHostEventBroker()
const pendingWorkspaceOpenRequests: LocalWorkspaceOpenRequest[] = startupWorkspaceOpenRequest
  ? [startupWorkspaceOpenRequest]
  : []
const pendingEmbeddedBrowserAttachments = new Map<
  number,
  Array<{ label: string; partition: string }>
>()
const rendererHealth = new RendererHealthService()
const systemSleep = new SystemSleepController()
const appUpdateLogger = new AppUpdateLogger(join(app.getPath('logs'), 'app-update.log'))
const executorHome =
  process.env.WEGENT_EXECUTOR_HOME?.trim() || join(app.getPath('home'), '.wework')
const logRetention = new LogRetentionService({
  directories: [
    app.getPath('logs'),
    join(executorHome, 'logs'),
    ...(process.env.WEGENT_EXECUTOR_LOG_DIR?.trim()
      ? [process.env.WEGENT_EXECUTOR_LOG_DIR.trim()]
      : []),
  ],
  onResult: reportLogCleanup,
})
autoUpdater.logger = appUpdateLogger
const appUpdates = new AppUpdateService({
  updater: autoUpdater,
  currentVersion: () => app.getVersion(),
  isPackaged: () => packagedApplication,
  prepareUpdate: async (version, channel) => {
    await componentUpdates?.stageUpdateForApp(version, channel)
  },
  prepareInstall: async () => {
    await prepareApplicationShutdown()
    await appUpdateLogger
      .flush()
      .catch(error =>
        console.error('[app-update] failed to flush updater log before installation', error)
      )
  },
  updateBaseUrl,
})
const systemResume = new SystemResumeBridge(powerMonitor, () => webContents.getAllWebContents())
const hasSingleInstanceLock = app.requestSingleInstanceLock({
  pluginDevelopmentCommand,
  workspaceOpenRequest: startupWorkspaceOpenRequest,
})

if (keepE2EWindowInBackground) {
  app.setActivationPolicy('prohibited')
}

if (!hasSingleInstanceLock) app.quit()

function focusStartupSplashIfActive(): boolean {
  const snapshot = startupSplash?.snapshot()
  if (!startupSplashBlocksMainWindowActivation(snapshot ?? null)) return false

  const target = startupSplashWindow
  if (target && !target.isDestroyed() && target.isVisible()) target.focus()
  return true
}

app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
  const instanceData =
    additionalData && typeof additionalData === 'object'
      ? (additionalData as Record<string, unknown>)
      : {}
  const command =
    typeof instanceData.pluginDevelopmentCommand === 'string'
      ? instanceData.pluginDevelopmentCommand
      : null
  const workspaceOpenRequest = normalizedWorkspaceOpenRequest(instanceData.workspaceOpenRequest)
  if (pluginDevelopmentInstance && command) {
    void pluginDevelopmentChildRuntime?.handleCommand(command)
    return
  }
  if (workspaceOpenRequest) queueWorkspaceOpenRequest(workspaceOpenRequest)
  if (keepE2EWindowInBackground) return
  if (focusStartupSplashIfActive()) return
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function normalizedWorkspaceOpenRequest(value: unknown): LocalWorkspaceOpenRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (!path) return null
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  return { path, ...(label ? { label } : {}) }
}

function queueWorkspaceOpenRequest(request: LocalWorkspaceOpenRequest): void {
  pendingWorkspaceOpenRequests.push(request)
  desktopHostEvents.publish('wework-open-local-workspace-requested', {})
}

function takePendingWorkspaceOpenRequests(): LocalWorkspaceOpenRequest[] {
  return pendingWorkspaceOpenRequests.splice(0)
}

rendererHealth.on('change', () => {
  mainWindow?.webContents.send('runtime:changed')
})

function secureDshContents(contents: WebContents, dshUrl: string): void {
  const allowedOrigin = new URL(dshUrl).origin
  installContextMenu(contents, 'app')
  contents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url)
    if (target.origin === allowedOrigin) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === allowedOrigin) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const route = embeddedBrowserRouteFromParams(params as Record<string, unknown>)
    console.log('[embedded-browser] webview attachment requested', {
      ownerId: contents.id,
      partition: params.partition ?? null,
      routeLabel: route?.label ?? null,
      src: params.src ?? null,
    })
    if (!route) {
      console.warn('[embedded-browser] rejected unknown webview attachment', {
        ownerId: contents.id,
        partition: params.partition ?? null,
        src: params.src ?? null,
      })
      event.preventDefault()
      return
    }
    const queue = pendingEmbeddedBrowserAttachments.get(contents.id) ?? []
    queue.push({ label: route.label, partition: route.routePartition })
    pendingEmbeddedBrowserAttachments.set(contents.id, queue)
    params.partition = EMBEDDED_BROWSER_PARTITION
    webPreferences.session = session.fromPartition(EMBEDDED_BROWSER_PARTITION)
    webPreferences.preload = browserAnnotationPreloadPath
    delete params.allowpopups
    delete params.disablewebsecurity
    delete params.webpreferences
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.webviewTag = false
    webPreferences.plugins = false
  })
  contents.on('did-attach-webview', (_event, guestContents) => {
    const queue = pendingEmbeddedBrowserAttachments.get(contents.id)
    const pending = queue?.shift()
    if (queue?.length === 0) pendingEmbeddedBrowserAttachments.delete(contents.id)
    if (
      !pending ||
      !embeddedBrowser ||
      guestContents.session !== session.fromPartition(EMBEDDED_BROWSER_PARTITION)
    ) {
      console.warn('[embedded-browser] rejected attached webview', {
        guestId: guestContents.id,
        hasBrowserManager: Boolean(embeddedBrowser),
        ownerId: contents.id,
        pendingLabel: pending?.label ?? null,
        sessionMatches: guestContents.session === session.fromPartition(EMBEDDED_BROWSER_PARTITION),
      })
      guestContents.close()
      return
    }
    console.log('[embedded-browser] webview attached', {
      guestId: guestContents.id,
      label: pending.label,
      ownerId: contents.id,
    })
    embeddedBrowser.attach(pending.label, guestContents)
    const browserManager = embeddedBrowser
    installContextMenu(
      guestContents,
      'browser',
      createNativeContextMenuActions(guestContents, url =>
        browserManager.requestPopupTab(pending.label, url)
      )
    )
  })
  contents.once('destroyed', () => pendingEmbeddedBrowserAttachments.delete(contents.id))
}

ipcMain.on('wework:browser-annotation-event', (event, payload: unknown) => {
  browserAnnotations?.handleRuntimeEvent(event.sender.id, payload)
})

function embeddedBrowserRouteFromParams(
  params: Record<string, unknown>
): { label: string; routePartition: string } | null {
  const customLabel = params['data-wework-browser-label']
  const partition = typeof params.partition === 'string' ? params.partition : null
  const routePartition = embeddedBrowserRoutePartition(partition)
  if (!routePartition?.startsWith(EMBEDDED_BROWSER_ROUTE_PARTITION_PREFIX)) return null
  if (
    typeof customLabel === 'string' &&
    customLabel.trim() &&
    routePartition ===
      `${EMBEDDED_BROWSER_ROUTE_PARTITION_PREFIX}${encodeURIComponent(
        `wework\0${customLabel.trim()}`
      )}`
  ) {
    return { label: customLabel.trim(), routePartition }
  }
  try {
    const identity = decodeURIComponent(
      routePartition.slice(EMBEDDED_BROWSER_ROUTE_PARTITION_PREFIX.length)
    )
    const [scope, label] = identity.split('\0')
    if (scope !== 'wework' || !label?.trim()) return null
    return { label: label.trim(), routePartition }
  } catch {
    return null
  }
}

function embeddedBrowserRoutePartition(partition: string | null): string | null {
  if (!partition) return null
  const hostSeparatorIndex = partition.lastIndexOf(EMBEDDED_BROWSER_ROUTE_HOST_SEPARATOR)
  if (hostSeparatorIndex === -1) return partition
  const hostIdentity = partition.slice(
    hostSeparatorIndex + EMBEDDED_BROWSER_ROUTE_HOST_SEPARATOR.length
  )
  const generationSeparatorIndex = hostIdentity.lastIndexOf(':')
  if (generationSeparatorIndex === -1) return null
  const rendererInstanceId = hostIdentity.slice(0, generationSeparatorIndex)
  const hostGeneration = Number(hostIdentity.slice(generationSeparatorIndex + 1))
  if (!rendererInstanceId || !Number.isInteger(hostGeneration) || hostGeneration <= 0) {
    return null
  }
  return partition.slice(0, hostSeparatorIndex)
}

function registerDshWindowLabel(contents: WebContents, label: string): void {
  dshWindowLabels.set(contents.id, label)
  contents.once('destroyed', () => dshWindowLabels.delete(contents.id))
}

function installDshWindowLabelHeaders(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const label =
      typeof details.webContentsId === 'number'
        ? dshWindowLabels.get(details.webContentsId)
        : undefined
    callback({
      requestHeaders: label
        ? { ...details.requestHeaders, 'X-Wework-Window-Label': label }
        : details.requestHeaders,
    })
  })
}

function layoutPrimaryView(): void {
  embeddedBrowser?.layoutAll()
}

const loadPrimaryDshView = createSingleFlight(async (): Promise<void> => {
  if (!mainWindow || !desktopRuntime) return
  if (!desktopRuntime.state().ready) return
  if (primaryDshLoaded) return
  logStartupStep('primary-renderer-load', 'started')
  rendererHealth.loading()
  const dshUrl = desktopRuntime.coreDshUrl()
  const contents = mainWindow.webContents
  if (!primaryDshSecurityInstalled) {
    secureDshContents(contents, dshUrl)
    registerDshWindowLabel(contents, 'main')
    primaryDshSecurityInstalled = true
  }
  contents.once('did-finish-load', () => {
    primaryDshLoaded = true
    runtimeError = null
    rendererHealth.ready()
    logStartupStep('primary-renderer-load', 'completed')
  })
  contents.on('unresponsive', () => rendererHealth.unresponsive())
  contents.on('responsive', () => rendererHealth.responsive())
  contents.once('render-process-gone', (_event, details) => {
    primaryDshLoaded = false
    if (quitting) return
    if (!rendererHealth.crashed(details.reason)) {
      runtimeError = 'DSH renderer repeatedly crashed'
      return
    }
    rendererHealth.recreating()
    void loadPrimaryDshView().catch(error => {
      runtimeError = error instanceof Error ? error.message : String(error)
      rendererHealth.failed('renderer_recreation_failed')
    })
  })
  try {
    await rendererStorage?.prepareOrigin(new URL(dshUrl).origin, {
      clearAll: () => contents.session.clearData({ dataTypes: ['localStorage'] }),
      clearOrigin: origin =>
        contents.session.clearData({
          dataTypes: ['localStorage'],
          origins: [origin],
          originMatchingMode: 'origin-in-all-contexts',
        }),
    })
    const targetUrl = new URL(dshUrl)
    if (pluginDevelopmentInstance) {
      targetUrl.searchParams.set(
        'weworkDevTitle',
        process.env.WEWORK_PLUGIN_DEVELOPMENT_TITLE?.trim() || 'Core DSH plugin'
      )
      const sourceRoot = process.env.WEWORK_PLUGIN_DEVELOPMENT_ROOT?.trim()
      if (sourceRoot) targetUrl.searchParams.set('weworkDevWorktree', sourceRoot)
    }
    await contents.loadURL(targetUrl.toString(), {
      extraHeaders: 'X-Wework-Window-Label: main',
    })
  } catch (error) {
    primaryDshLoaded = false
    rendererHealth.failed('renderer_load_failed')
    logStartupStep('primary-renderer-load', 'failed')
    throw error
  }
})

function disposeSystemDragWindow(): void {
  systemDragWindow?.destroy()
  pendingSystemDragWindow?.destroy()
  systemDragWindow = null
  pendingSystemDragWindow = null
  systemDragWindowCreationPromise = null
}

function disposeCoreDshViews(): void {
  for (const workspaceWindow of workspaceWindows.values()) {
    if (!workspaceWindow.isDestroyed()) workspaceWindow.destroy()
  }
  workspaceWindows.clear()
  disposeSystemDragWindow()
  popoutWindow?.destroy()
  popoutWindow = null
  popoutWindowCreationPromise = null
  popoutWindowReadyPromise = null
  primaryDshLoaded = false
}

async function restartPrimaryCoreDsh(): Promise<void> {
  if (!desktopRuntime) throw new Error('Core desktop runtime is unavailable')
  disposeCoreDshViews()
  await mainWindow?.webContents.loadURL('about:blank')
  await desktopRuntime.restartCoreDsh()
  await loadPrimaryDshView()
}

function scheduleCoreDshRestart(): void {
  setTimeout(() => {
    void (async () => {
      if (!desktopRuntime) throw new Error('Core desktop runtime is unavailable')
      runtimePhase = 'initializing'
      runtimeError = null
      rendererHealth.loading()
      notifyRuntimeChanged()
      await restartPrimaryCoreDsh()
      runtimePhase = 'ready'
      notifyRuntimeChanged()
    })().catch(error => {
      runtimePhase = 'failed'
      runtimeError = error instanceof Error ? error.message : String(error)
      rendererHealth.failed('core_dsh_restart_failed')
      notifyRuntimeChanged()
      console.error('[runtime] Core DSH restart failed', error)
    })
  }, 100)
}

async function openWorkspaceWindow(input: {
  label: string
  route: string
  title: string
}): Promise<void> {
  if (!desktopRuntime) throw new Error('Core desktop runtime is unavailable')
  if (!/^workspace-[a-zA-Z0-9_-]+$/.test(input.label)) {
    throw new Error(`Workspace window label is invalid: ${input.label}`)
  }
  const existing = workspaceWindows.get(input.label)
  if (existing && !existing.isDestroyed()) {
    presentWindow(existing)
    return
  }
  const dshUrl = desktopRuntime.coreDshUrl()
  const target = new URL(input.route, desktopRuntime.coreDshOrigin())
  if (target.origin !== new URL(dshUrl).origin) {
    throw new Error('Workspace window route must belong to the Core DSH runtime')
  }
  const workspaceWindow = new BrowserWindow({
    ...desktopWindowFrameOptions(),
    width: 1280,
    height: 800,
    title: input.title,
    backgroundColor: '#181818',
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      preload: dshPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  })
  workspaceWindows.set(input.label, workspaceWindow)
  secureDshContents(workspaceWindow.webContents, dshUrl)
  registerDshWindowLabel(workspaceWindow.webContents, input.label)
  workspaceWindow.on('closed', () => {
    if (workspaceWindows.get(input.label) === workspaceWindow) {
      workspaceWindows.delete(input.label)
    }
  })
  try {
    await workspaceWindow.loadURL(target.toString(), {
      extraHeaders: `X-Wework-Window-Label: ${input.label}`,
    })
    presentWindow(workspaceWindow)
  } catch (error) {
    workspaceWindows.delete(input.label)
    workspaceWindow.destroy()
    throw error
  }
}

async function ensureAuxiliaryWindow(
  kind: 'system-drag-panel' | 'popout-window'
): Promise<BrowserWindow> {
  if (!desktopRuntime) throw new Error('Core desktop runtime is unavailable')
  const existing = kind === 'system-drag-panel' ? systemDragWindow : popoutWindow
  if (existing && !existing.isDestroyed()) return existing
  if (kind === 'system-drag-panel' && systemDragWindowCreationPromise) {
    return systemDragWindowCreationPromise
  }
  if (kind === 'popout-window' && popoutWindowCreationPromise) {
    return popoutWindowCreationPromise
  }
  const creationPromise = createAuxiliaryWindow(kind)
  if (kind === 'system-drag-panel') {
    systemDragWindowCreationPromise = creationPromise
    try {
      return await creationPromise
    } finally {
      if (systemDragWindowCreationPromise === creationPromise) {
        systemDragWindowCreationPromise = null
      }
    }
  }
  popoutWindowCreationPromise = creationPromise
  try {
    return await creationPromise
  } finally {
    if (popoutWindowCreationPromise === creationPromise) {
      popoutWindowCreationPromise = null
    }
  }
}

async function createAuxiliaryWindow(
  kind: 'system-drag-panel' | 'popout-window'
): Promise<BrowserWindow> {
  if (!desktopRuntime) throw new Error('Core desktop runtime is unavailable')
  const isSystemDrag = kind === 'system-drag-panel'
  const target = resolveDshAppRoute(
    desktopRuntime.coreDshUrl(),
    isSystemDrag ? 'system-drag' : 'popout'
  )
  const auxiliaryWindow = new BrowserWindow({
    width: isSystemDrag ? 440 : 470,
    height: isSystemDrag ? 60 : 112,
    parent: isSystemDrag
      ? (BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined)
      : undefined,
    resizable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: isSystemDrag,
    show: false,
    type: isSystemDrag && process.platform === 'darwin' ? 'panel' : undefined,
    backgroundColor: '#00000000',
    webPreferences: {
      backgroundThrottling: false,
      preload: dshPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  if (isSystemDrag) pendingSystemDragWindow = auxiliaryWindow
  secureDshContents(auxiliaryWindow.webContents, desktopRuntime.coreDshUrl())
  registerDshWindowLabel(auxiliaryWindow.webContents, kind)
  auxiliaryWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[auxiliary-window] renderer failed to load', {
      kind,
      code,
      description,
      url,
    })
  })
  auxiliaryWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[auxiliary-window] renderer process exited', { kind, ...details })
  })
  auxiliaryWindow.on('closed', () => {
    if (kind === 'system-drag-panel') {
      if (systemDragWindow === auxiliaryWindow) systemDragWindow = null
      if (pendingSystemDragWindow === auxiliaryWindow) pendingSystemDragWindow = null
    } else {
      if (popoutWindow === auxiliaryWindow) popoutWindow = null
      if (popoutWindowReadyPromise === readinessPromise) {
        popoutWindowReadyPromise = null
      }
    }
  })
  let readinessPromise: Promise<void> | null = null
  try {
    await auxiliaryWindow.loadURL(target.toString(), {
      extraHeaders: `X-Wework-Window-Label: ${kind}`,
    })
    if (isSystemDrag) {
      readinessPromise = waitForRendererSelector(
        auxiliaryWindow.webContents,
        '[data-testid="system-drag-panel"]'
      )
      await readinessPromise
      if (pendingSystemDragWindow !== auxiliaryWindow || auxiliaryWindow.isDestroyed()) {
        throw new Error('System drag panel creation was disposed')
      }
      pendingSystemDragWindow = null
      systemDragWindow = auxiliaryWindow
    } else {
      popoutWindow = auxiliaryWindow
      readinessPromise = waitForRendererSelector(
        auxiliaryWindow.webContents,
        '[data-testid="popout-workbench-page"]'
      )
      popoutWindowReadyPromise = readinessPromise
      void readinessPromise.catch(error => {
        console.error('[popout-window] renderer failed to become ready', error)
      })
    }
    return auxiliaryWindow
  } catch (error) {
    if (pendingSystemDragWindow === auxiliaryWindow) pendingSystemDragWindow = null
    if (!auxiliaryWindow.isDestroyed()) auxiliaryWindow.destroy()
    throw error
  }
}

async function showSystemDragPanel(): Promise<void> {
  const target = await ensureAuxiliaryWindow('system-drag-panel')
  const owner = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (owner && owner !== target && target.getParentWindow() !== owner) {
    target.setParentWindow(owner)
  }
  target.setAlwaysOnTop(true, 'pop-up-menu')
  if (process.platform === 'darwin') {
    target.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const x = Math.round(display.workArea.x + (display.workArea.width - 440) / 2)
  target.setPosition(x, display.workArea.y + 8)
  target.showInactive()
  target.moveTop()
}

async function showPopoutWindow(): Promise<void> {
  const target = await ensureAuxiliaryWindow('popout-window')
  await popoutWindowReadyPromise
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  target.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - 470) / 2),
    Math.round(display.workArea.y + (display.workArea.height - 112) / 2)
  )
  presentWindow(target)
}

function resolvePopoutShortcut(preferenceRecord: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(preferenceRecord, 'popoutWindowShortcut')) {
    return DEFAULT_POPOUT_WINDOW_SHORTCUT
  }
  const value = preferenceRecord.popoutWindowShortcut
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function updateDesktopPreferences(
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const store = requiredPreferences()
  if (!Object.prototype.hasOwnProperty.call(patch, 'popoutWindowShortcut')) {
    return store.update(patch)
  }

  const previousPreferences = await store.read()
  const previousShortcut = resolvePopoutShortcut(previousPreferences)
  const nextShortcut = resolvePopoutShortcut(patch)
  popoutShortcut?.configure(nextShortcut)
  try {
    return await store.update(patch)
  } catch (error) {
    popoutShortcut?.configure(previousShortcut)
    throw error
  }
}

async function createWindow(startupTheme: StartupSplashTheme): Promise<void> {
  logStartupStep('windows-create', 'started', { theme: startupTheme })
  const developmentTitle = process.env.WEWORK_PLUGIN_DEVELOPMENT_TITLE?.trim()
  const windowTitle =
    pluginDevelopmentInstance && developmentTitle
      ? `Wework Plugin Development — ${developmentTitle}`
      : (developmentDockIdentity?.displayName ?? 'Wework')
  mainWindow = new BrowserWindow({
    ...desktopWindowFrameOptions(),
    width: 1440,
    height: 960,
    title: windowTitle,
    backgroundColor: startupTheme === 'dark' ? '#181818' : '#fafafa',
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      preload: dshPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  })
  startupSplashWindow = new BrowserWindow({
    ...desktopWindowFrameOptions(),
    width: 1440,
    height: 960,
    title: windowTitle,
    backgroundColor: startupTheme === 'dark' ? '#181818' : '#fafafa',
    show: false,
    webPreferences: {
      preload: startupSplashPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  startupSplash = new StartupSplash({
    window: {
      close: () => startupSplashWindow?.close(),
      isDestroyed: () => startupSplashWindow?.isDestroyed() ?? true,
      isVisible: () => startupSplashWindow?.isVisible() ?? false,
      on: (_event, listener) => startupSplashWindow?.on('close', listener),
      once: (_event, listener) => startupSplashWindow?.once('closed', listener),
      show: () => {
        if (!keepE2EWindowInBackground) startupSplashWindow?.show()
      },
      webContents: {
        capturePage: async () => {
          if (!startupSplashWindow) throw new Error('Startup splash window is unavailable')
          return startupSplashWindow.webContents.capturePage()
        },
        executeJavaScript: async code => {
          if (!startupSplashWindow) throw new Error('Startup splash window is unavailable')
          return startupSplashWindow.webContents.executeJavaScript(code)
        },
        isDestroyed: () => startupSplashWindow?.webContents.isDestroyed() ?? true,
      },
    },
    theme: startupTheme,
  })
  startupSplashWindow.on('closed', () => {
    startupSplashWindow = null
  })
  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('window:focus-changed', true)
  })
  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window:focus-changed', false)
  })
  mainWindow.on('resize', layoutPrimaryView)
  mainWindow.on('close', event => {
    if (quitting) return
    if (pluginDevelopmentInstance) {
      requestApplicationShutdown(() => app.quit())
      return
    }
    event.preventDefault()
    void handleMainWindowCloseRequest()
  })
  mainWindow.on('closed', () => {
    primaryDshLoaded = false
    primaryDshSecurityInstalled = false
    mainWindow = null
  })
  const mainShellLoading = mainWindow.loadFile(resolve(packageRoot, 'dist/shell/index.html'), {
    query: { theme: startupTheme },
  })
  logStartupStep('startup-splash-load', 'started')
  await startupSplashWindow.loadFile(resolve(packageRoot, 'dist/shell/startup-splash/index.html'), {
    query: { theme: startupTheme },
  })
  logStartupStep('startup-splash-load', 'completed')
  logStartupStep('startup-splash-show', 'started')
  await startupSplash.show()
  logStartupStep('startup-splash-show', 'completed')
  logStartupStep('main-shell-load', 'started')
  await mainShellLoading
  logStartupStep('main-shell-load', 'completed')
  logStartupStep('windows-create', 'completed')
}

async function setDockVisible(visible: boolean): Promise<void> {
  if (process.platform !== 'darwin' || !app.dock) {
    dockVisible = true
    return
  }
  if (dockVisible === visible) return
  if (visible) await app.dock.show()
  else await app.dock.hide()
  dockVisible = visible
}

async function applyWindowCloseDecision(decision: WindowCloseDecision): Promise<void> {
  switch (decision.type) {
    case 'allow-close':
    case 'no-action':
      return
    case 'request-quit':
      requestApplicationShutdown(() => app.quit())
      return
    case 'show-close-to-tray-confirmation':
      desktopHostEvents.publish('window.close-to-tray-requested', {})
      return
    case 'hide-to-background':
      await hideMainWindowToBackground()
  }
}

async function handleMainWindowCloseRequest(): Promise<void> {
  try {
    const decision = await windowClosePolicy?.requestClose(false)
    if (decision) await applyWindowCloseDecision(decision)
  } catch (error) {
    console.error('[window] failed to process close request', error)
  }
}

async function hideMainWindowToBackground(): Promise<void> {
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  console.log('windowWillClose: electron close-to-tray')
  target.hide()
  if (process.platform === 'darwin') {
    if (keepE2EWindowInBackground) {
      e2eForegroundActivationAllowed = false
      app.setActivationPolicy('prohibited')
    }
    app.hide()
    await setDockVisible(false)
  }
  primaryDshLoaded = false
}

async function closeMainWindowToTray(): Promise<void> {
  const decision = await windowClosePolicy?.confirmCloseToTray()
  if (decision) await applyWindowCloseDecision(decision)
}

async function cancelMainWindowClose(): Promise<void> {
  const decision = await windowClosePolicy?.cancelCloseToTray()
  if (decision) await applyWindowCloseDecision(decision)
}

async function reactivateMainWindow(): Promise<void> {
  if (focusStartupSplashIfActive()) return
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  if (keepE2EWindowInBackground) {
    e2eForegroundActivationAllowed = true
    app.setActivationPolicy('regular')
  }
  await setDockVisible(true)
  await loadPrimaryDshView()
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
}

function dispatchTrayAction(action: TrayAction): void {
  if (action.type === 'quit-app') {
    requestApplicationShutdown(() => app.quit())
    return
  }
  void reactivateMainWindow().catch(error => {
    console.error('[window] failed to handle tray action', error)
  })
  if (action.type === 'open-settings' || action.type === 'open-task') {
    desktopHostEvents.publish('tray.action', action)
  }
}

function createTrayManager(): ElectronTrayManager<Electron.Menu | null, Tray> {
  const resourcesRoot = packagedApplication ? process.resourcesPath : developmentResourcesRoot
  const iconPath = join(resourcesRoot, 'icons', '128x128.png')
  const trayGuid = trayGuidForApplicationId(applicationId)
  return new ElectronTrayManager({
    createTray: () => new Tray(createTrayIcon(nativeImage, iconPath), trayGuid),
    buildMenu: template => Menu.buildFromTemplate(template as MenuItemConstructorOptions[]),
    dispatchAction: dispatchTrayAction,
    applyIcon: (tray, state) => {
      tray.setImage(
        createTrayIcon(nativeImage, iconPath, state.usageTitle, process.platform, {
          runningCount: state.runningCount,
          showRunningStatus: state.showRunningStatus,
        })
      )
      tray.setTitle('')
    },
  })
}

function installIpc(): void {
  ipcMain.handle('startup-recovery:retry', event => {
    assertStartupRecoverySender(event.sender.id, startupSplashWindow?.webContents.id ?? null)
    logStartupStep('startup-recovery-retry', 'started')
    return requiredStartupRecovery().run('retry')
  })
  ipcMain.handle('startup-recovery:recover-workbench', event => {
    assertStartupRecoverySender(event.sender.id, startupSplashWindow?.webContents.id ?? null)
    logStartupStep('startup-recovery-workbench', 'started')
    return requiredStartupRecovery().run('workbench')
  })
  ipcMain.handle('startup-recovery:reset-app-state', event => {
    assertStartupRecoverySender(event.sender.id, startupSplashWindow?.webContents.id ?? null)
    logStartupStep('startup-recovery-app-state', 'started')
    return requiredStartupRecovery().run('app-state')
  })
  ipcMain.handle('cloud-credentials:get-device-public-key', () =>
    requiredCloudCredentials().devicePublicKey()
  )
  ipcMain.handle('cloud-credentials:claim-authorization', async (_event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new CloudCredentialError('request_failed', 'Authorization input is invalid')
      }
      const value = input as Record<string, unknown>
      return {
        ok: true,
        value: await requiredCloudCredentials().claimAuthorization({
          apiBaseUrl: requiredText(value.apiBaseUrl, 'apiBaseUrl'),
          sessionId: requiredText(value.sessionId, 'sessionId'),
          pollToken: requiredText(value.pollToken, 'pollToken'),
        }),
      }
    } catch (error) {
      return cloudCredentialFailure(error)
    }
  })
  ipcMain.handle('cloud-credentials:refresh-access-token', async (_event, apiBaseUrl: unknown) => {
    try {
      return {
        ok: true,
        value: await requiredCloudCredentials().refreshAccessToken(
          requiredText(apiBaseUrl, 'apiBaseUrl')
        ),
      }
    } catch (error) {
      return cloudCredentialFailure(error)
    }
  })
  ipcMain.handle('cloud-credentials:clear', () => requiredCloudCredentials().clear())
  ipcMain.handle('runtime:get-state', () => ({
    ...(desktopRuntime?.state() ?? {
      coreDshUrl: null,
      executorConfigured: false,
      workbenchRuntimeCount: 0,
      ready: false,
    }),
    phase: runtimePhase,
    ready:
      runtimePhase === 'ready' && runtimeError === null && desktopRuntime?.state().ready === true,
    error: runtimeError,
    rendererHealth: rendererHealth.snapshot(),
  }))
  ipcMain.handle('runtime:reload-dsh', async () => {
    if (runtimePhase === 'ready' && primaryDshLoaded && mainWindow) {
      mainWindow.webContents.reload()
      return
    }
    await startDesktopRuntime()
  })
  ipcMain.handle('runtime:list-execution-environments', async () => {
    const runtime = await electronNodeRuntime()
    const configuredPath = await configuredNodePath()
    return [
      {
        ...runtime.status,
        configuredPath,
        restartRequired:
          configuredPath !== (runtime.status.source === 'configured' ? runtime.status.path : null),
      },
    ]
  })
  ipcMain.handle('runtime:choose-node-executable', async () => {
    const options: OpenDialogOptions = {
      title: 'Select Node.js executable',
      properties: ['openFile'],
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    const version = await readNodeVersion(path)
    await requiredPreferences().update({ nodeExecutablePath: path })
    return { path, version }
  })
  ipcMain.handle('runtime:use-builtin-node', async () => {
    await requiredPreferences().update({ nodeExecutablePath: null })
  })
}

async function shutdown(): Promise<void> {
  pluginDevelopmentChildRuntime?.stopWatcher()
  await pluginDevelopmentChildRuntime?.writeState('stopping')
  await logRetention.stop()
  systemResume.stop()
  systemSleep.stop()
  trayNativeStatus?.stop()
  trayNativeStatus = null
  trayManager?.destroy()
  trayManager = null
  for (const workspaceWindow of workspaceWindows.values()) {
    if (!workspaceWindow.isDestroyed()) workspaceWindow.destroy()
  }
  workspaceWindows.clear()
  disposeSystemDragWindow()
  popoutWindow?.destroy()
  popoutWindow = null
  popoutWindowCreationPromise = null
  popoutWindowReadyPromise = null
  popoutShortcut?.dispose()
  popoutShortcut = null
  embeddedBrowser?.stop()
  browserAnnotations = null
  const browserBridge = embeddedBrowserBridge
  embeddedBrowserBridge = null
  const controlBridge = desktopControlBridge
  desktopControlBridge = null
  const computerUseService = computerUse
  computerUse = null
  const development = pluginDevelopment
  pluginDevelopment = null
  await Promise.allSettled([
    browserBridge?.stop(),
    controlBridge?.stop(),
    computerUseService?.stop(),
    development?.stop(),
    desktopRuntime?.stop(),
  ])
  await pluginDevelopmentChildRuntime?.writeState('stopped')
}

function requestApplicationShutdown(exit: () => void): void {
  void prepareApplicationShutdown().finally(exit)
}

function prepareApplicationShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  quitting = true
  shutdownPromise = shutdown()
  return shutdownPromise
}

function smartAppRuntimeHost(): SmartAppRuntimeHost | null {
  if (!desktopRuntime) return null
  return {
    open: async launch => {
      await desktopRuntime?.openWorkbenchRuntime(launch)
    },
    close: tabId => desktopRuntime?.closeWorkbenchRuntime(tabId) ?? Promise.resolve(),
    runningTabIds: () =>
      new Set(desktopRuntime?.diagnostics().workbenchRuntimes.map(item => item.tabId) ?? []),
  }
}

async function configureDesktopRuntime(): Promise<void> {
  if (desktopRuntime) return
  logStartupStep('runtime-configure', 'started')
  const environment = await desktopEnvironment()
  if (!pluginDevelopmentInstance && !pluginDevelopment) {
    pluginDevelopment = new PluginDevelopmentManager({
      ...currentElectronLaunch(),
      environment,
      userDataDirectory: app.getPath('userData'),
      onStateChanged: state => {
        desktopHostEvents.publish(
          'plugin-development.state',
          state as unknown as Record<string, unknown>
        )
      },
      onProjectClassificationChanged: classification => {
        desktopHostEvents.publish(
          'plugin-development.project-classification',
          classification as unknown as Record<string, unknown>
        )
      },
    })
  }
  if (!preferences) throw new Error('Desktop preferences are unavailable')
  if (!rendererStorage) throw new Error('Renderer storage is unavailable')
  const feedback = new FeedbackBundleManager({
    appVersion: () => app.getVersion(),
    cacheDirectory: join(app.getPath('userData'), 'cache'),
    downloadsDirectory: app.getPath('downloads'),
    logDirectories: [app.getPath('logs')],
  })
  const secureStorage = new SecureValueStore(app.getPath('userData'))
  embeddedBrowser = new EmbeddedBrowserManager(app.getPath('userData'), event => {
    desktopHostEvents.publish('browser.event', { ...event })
  })
  browserAnnotations = new BrowserAnnotationController({
    browser: embeddedBrowser,
    publish: state => {
      desktopHostEvents.publish(
        'browser.annotation-state',
        state as unknown as Record<string, unknown>
      )
    },
  })
  embeddedBrowserBridge = new EmbeddedBrowserBridge(
    embeddedBrowser,
    environment.WEGENT_EXECUTOR_HOME?.trim() || join(app.getPath('home'), '.wework')
  )
  environment.WEWORK_EMBEDDED_BROWSER_BRIDGE_RUNTIME_FILE = await embeddedBrowserBridge.start()
  desktopControlBridge = new WeworkDesktopControlBridge({
    instanceId: desktopControlInstanceId(),
    instanceKind: pluginDevelopmentInstance ? 'core-dsh-plugin-development' : 'main',
    displayName:
      process.env.WEWORK_PLUGIN_DEVELOPMENT_TITLE?.trim() ||
      developmentDockIdentity?.displayName ||
      'Wework',
    projectRoot: process.env.WEWORK_PLUGIN_DEVELOPMENT_ROOT?.trim() || null,
    registryDirectory: desktopControlRegistryDirectory(),
    window: () => mainWindow,
  })
  await desktopControlBridge.start()
  computerUse = new ComputerUseService(
    environment.WEGENT_EXECUTOR_HOME?.trim() || join(app.getPath('home'), '.wework')
  )
  const runtimeRoot = environment.WEWORK_HARNESS_RUNTIME_ROOT?.trim()
  if (runtimeRoot) {
    smartApps = new SmartAppManager({
      dataDirectory: app.getPath('userData'),
      downloadsDirectory: app.getPath('downloads'),
      logDirectory: app.getPath('logs'),
      runtimeRoot,
      environment,
      runtimeHost: smartAppRuntimeHost,
      ensureWorkbenchRuntime:
        packagedApplication && !process.env.WEWORK_HARNESS_RUNTIME_ROOT?.trim()
          ? async () => {
              const paths = packagedHarnessRuntimePaths()
              const resources = environment.WEWORK_HARNESS_RESOURCE_ROOT?.trim()
              if (!resources) throw new Error('DSH runtime resources are unavailable')
              await materializeBundledRuntimes(resources, paths.cache, ['workbench'])
            }
          : undefined,
    })
  }
  desktopRuntime = new DesktopRuntime({
    environment,
    dataDirectory: app.getPath('userData'),
    logDirectory: app.getPath('logs'),
    onExecutorEvent: (event, payload) => {
      systemSleep.handleExecutorEvent(event, payload)
      trayNativeStatus?.handleExecutorEvent(event)
    },
    hostPipe: new HostPipeServer(
      createElectronCapabilityRouter(
        () => mainWindow,
        () => rendererHealth.snapshot(),
        () => smartApps,
        preferences,
        rendererStorage,
        embeddedBrowser,
        computerUse,
        {
          coreDshPlugins: () => desktopRuntime,
          pluginDevelopment: () =>
            pluginDevelopment
              ? {
                  classify: sourceRoot => pluginDevelopment!.classify(sourceRoot),
                  deleteData: () => pluginDevelopment!.deleteData(),
                  focus: () => pluginDevelopment!.focus(),
                  initialize: sourceRoot => pluginDevelopment!.initialize(sourceRoot),
                  list: () => pluginDevelopment!.list(),
                  observe: sourceRoot => pluginDevelopment!.observe(sourceRoot),
                  openDevTools: () => pluginDevelopment!.openDevTools(),
                  openLogDirectory: async () => {
                    const [developmentSession] = await pluginDevelopment!.list()
                    if (!developmentSession) {
                      throw new Error('No Wework plugin development session exists')
                    }
                    const error = await shell.openPath(developmentSession.logDirectory)
                    if (error) throw new Error(error)
                  },
                  restartCoreDsh: () => pluginDevelopment!.restartCoreDsh(),
                  start: sourceRoot => pluginDevelopment!.start(sourceRoot),
                  stop: () => pluginDevelopment!.stop(),
                  validate: sourceRoot => pluginDevelopment!.validate(sourceRoot),
                }
              : null,
          appUpdates,
          browserAnnotations,
          cleanupStaleTemporaryImages,
          events: desktopHostEvents,
          feedback,
          openRuntimeTask: taskAddressId =>
            dispatchTrayAction({
              type: 'open-task',
              source: 'notification',
              taskId: taskAddressId,
            }),
          secureStorage,
          takePendingWorkspaceOpenRequests,
          updatePreferences: updateDesktopPreferences,
        },
        {
          captureTarget: windowLabel =>
            windowLabel === 'main'
              ? (mainWindow?.webContents ?? null)
              : windowLabel === 'popout-window'
                ? (popoutWindow?.webContents ?? null)
                : windowLabel === 'system-drag-panel'
                  ? (systemDragWindow?.webContents ?? null)
                  : (workspaceWindows.get(windowLabel)?.webContents ?? null),
          cancelCloseToTray: cancelMainWindowClose,
          closeToTray: closeMainWindowToTray,
          focusMainWindow: reactivateMainWindow,
          focusWindow: windowLabel => {
            const target =
              windowLabel === 'main' ? mainWindow : (workspaceWindows.get(windowLabel) ?? null)
            if (target) presentWindow(target)
          },
          hideMainWindow: hideMainWindowToBackground,
          dockVisible: () => dockVisible,
          rendererStartupReady: async source => {
            if (!mainWindow || mainWindow.isDestroyed()) return
            logStartupStep('renderer-startup-ready', 'completed', { source })
            if (!keepE2EWindowInBackground) mainWindow.show()
            logStartupStep('main-window-show', 'completed')
            await startupSplash?.close({
              capturePath: process.env.WEWORK_E2E_STARTUP_SPLASH_CAPTURE?.trim(),
            })
            logStartupStep('startup-splash-close', 'completed')
            if (!keepE2EWindowInBackground) {
              mainWindow.focus()
              mainWindow.webContents.focus()
            }
            scheduleComputerUseStartup()
          },
          rendererStartupFailed: () => {
            logStartupStep('renderer-startup', 'failed')
            return startupSplash?.showError()
          },
          startupSplashSnapshot: () => startupSplash?.snapshot() ?? null,
          trayActivate: activation => trayManager?.activate(activation) ?? false,
          traySetState: state => {
            trayManager?.setState(state)
            void trayNativeStatus?.refresh()
          },
          traySnapshot: () => trayManager?.snapshot() ?? null,
          openWorkspace: openWorkspaceWindow,
          popoutWindowSnapshot: () => ({
            exists: Boolean(popoutWindow && !popoutWindow.isDestroyed()),
            focused: Boolean(
              popoutWindow && !popoutWindow.isDestroyed() && popoutWindow.isFocused()
            ),
            visible: Boolean(
              popoutWindow && !popoutWindow.isDestroyed() && popoutWindow.isVisible()
            ),
          }),
          capturePopout: async () => {
            const target = await ensureAuxiliaryWindow('popout-window')
            await popoutWindowReadyPromise
            return captureWebContentsDataUrl(target.webContents)
          },
          completeSystemDragDrop: async payload => {
            pendingSystemDrops.push(payload)
            await showPopoutWindow()
          },
          dismissPopout: () => popoutWindow?.hide(),
          dismissSystemDragPanel: () => systemDragWindow?.hide(),
          getSystemDragContext: () => systemDragContext,
          runtimeDiagnostics: () =>
            desktopRuntime?.diagnostics() ?? {
              coreDshPid: null,
              developmentPlugin: null,
              executorPid: null,
              workbenchRuntimes: [],
            },
          scheduleCoreDshRestart,
          setSystemDragContext: context => {
            systemDragContext = context
          },
          setSystemSleepEnabled: enabled => systemSleep.setEnabled(enabled),
          setSystemSleepTaskActive: (source, active) => systemSleep.setTaskActive(source, active),
          showPopout: showPopoutWindow,
          showSystemDragPanel: () =>
            showSystemDragPanel().catch(error => {
              console.error('Failed to show system drag panel:', error)
            }),
          systemDragPanelVisible: () =>
            Boolean(
              systemDragWindow && !systemDragWindow.isDestroyed() && systemDragWindow.isVisible()
            ),
          takePendingSystemDrops: () => {
            const drops = pendingSystemDrops
            pendingSystemDrops = []
            return drops
          },
          workspaceWindowSnapshots: () =>
            [...workspaceWindows.entries()].flatMap(([label, target]) =>
              target.isDestroyed()
                ? []
                : [
                    {
                      label,
                      focused: target.isFocused(),
                      visible: target.isVisible(),
                    },
                  ]
            ),
        }
      )
    ),
  })
  trayNativeStatus = new TrayNativeStatusController({
    preferences,
    requestExecutor: (method, params) => {
      if (!desktopRuntime) return Promise.reject(new Error('Desktop runtime is unavailable'))
      return desktopRuntime.requestExecutor(method, params)
    },
    apply: status => trayManager?.setNativeStatus(status),
  })
  logStartupStep('runtime-configure', 'completed')
}

function currentElectronLaunch(): { command: string; args: string[] } {
  const inheritedArguments = pluginDevelopmentElectronArguments(name =>
    app.commandLine.hasSwitch(name)
  )
  return packagedApplication
    ? { command: process.execPath, args: inheritedArguments }
    : { command: process.execPath, args: [packageRoot, ...inheritedArguments] }
}

function scheduleComputerUseStartup(): void {
  if (computerUseStartupScheduled || quitting) return
  const service = computerUse
  const store = preferences
  if (!service || !store) return
  computerUseStartupScheduled = true
  setImmediate(() => {
    void restoreComputerUseAfterStartup({
      isShuttingDown: () => quitting || computerUse !== service,
      readPreferences: () => store.read(),
      setEnabled: enabled => service.setEnabled(enabled),
    }).catch(error => {
      console.error('[computer-use] lazy startup failed', error)
    })
  })
}

function notifyRuntimeChanged(): void {
  mainWindow?.webContents.send('runtime:changed')
}

function startDesktopRuntime(): Promise<void> {
  if (runtimeStartPromise) return runtimeStartPromise
  logStartupStep('desktop-runtime-start', 'started')
  runtimePhase = 'initializing'
  runtimeError = null
  void pluginDevelopmentChildRuntime?.writeState('starting')
  notifyRuntimeChanged()
  runtimeStartPromise = (async () => {
    await configureDesktopRuntime()
    logStartupStep('core-dsh-start', 'started')
    await desktopRuntime?.start()
    logStartupStep('core-dsh-start', 'completed')
    trayNativeStatus?.start()
    await loadPrimaryDshView()
    logStartupStep('component-update-confirmation', 'started')
    await componentUpdates?.confirmStartup()
    logStartupStep('component-update-confirmation', 'completed')
    runtimePhase = 'ready'
    pluginDevelopmentChildRuntime?.startWatcher()
    await pluginDevelopmentChildRuntime?.writeState('ready')
    logStartupStep('desktop-runtime-start', 'completed')
    if (!pluginDevelopmentInstance && shouldStageDesktopComponentUpdates(process.env)) {
      void componentUpdates
        ?.stageAvailableUpdate()
        .then(staged => {
          if (staged) console.log('[components] update staged for the next application restart')
        })
        .catch(error => {
          console.error('[components] update check failed', error)
        })
    }
  })()
    .catch(async error => {
      if (await componentUpdates?.rollbackStartup()) {
        console.error('[components] startup failed after activation; rolling back and relaunching')
        app.relaunch()
        app.exit(1)
        return
      }
      runtimePhase = 'failed'
      runtimeError = error instanceof Error ? error.message : String(error)
      await pluginDevelopmentChildRuntime?.writeState(
        'error',
        error instanceof Error ? error : new Error(String(error))
      )
      logStartupStep('desktop-runtime-start', 'failed', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
      console.error('[runtime] startup failed', error)
      void startupSplash?.showError().catch(async splashError => {
        console.error('[startup-splash] failed to show runtime failure', splashError)
        if (!keepE2EWindowInBackground) mainWindow?.show()
        await startupSplash?.close()
      })
    })
    .finally(() => {
      runtimeStartPromise = null
      notifyRuntimeChanged()
    })
  return runtimeStartPromise
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    logStartupStep('electron-ready', 'completed')
    if (process.platform === 'darwin' && app.dock && developmentDockIdentity) {
      app.dock.setBadge(developmentDockIdentity.badge)
      console.info('[development] Dock identity configured', developmentDockIdentity)
    }
    logStartupStep('log-retention-start', 'started')
    await logRetention.start()
    logStartupStep('log-retention-start', 'completed')
    if (keepE2EWindowInBackground) {
      app.hide()
      app.dock?.hide()
      dockVisible = false
    }
    preferences = new PreferencesStore(app.getPath('userData'))
    rendererStorage = new RendererStorageStore(app.getPath('userData'))
    logStartupStep('desktop-stores-create', 'completed')
    if (!pluginDevelopmentInstance) {
      popoutShortcut = new GlobalShortcutController(globalShortcut, showPopoutWindow, error =>
        console.error('[popout-window] global shortcut failed', error)
      )
    }
    cloudCredentials = new CloudCredentialService(app.getPath('userData'))
    startupRecovery = new StartupRecoveryService({
      rendererStorage,
      preferences,
      cloudCredentials,
      clearCache: () => session.defaultSession.clearCache(),
      clearAppStorage: () =>
        session.defaultSession.clearStorageData({
          storages: ['serviceworkers', 'cachestorage'],
        }),
      log: logStartupStep,
      relaunch: () => app.relaunch(),
      shutdown: () => requestApplicationShutdown(() => app.exit(0)),
    })
    logStartupStep('startup-recovery-install', 'completed')
    installDshWindowLabelHeaders()
    installIpc()
    logStartupStep('desktop-ipc-install', 'completed')
    systemResume.start()
    windowClosePolicy = new WindowClosePolicy({
      read: async () => {
        const current = await preferences?.read()
        return {
          closeToTrayEnabled:
            typeof current?.closeToTrayEnabled === 'boolean' ? current.closeToTrayEnabled : true,
          closeToTrayHintSeen:
            typeof current?.closeToTrayHintSeen === 'boolean' ? current.closeToTrayHintSeen : false,
        }
      },
      markCloseToTrayHintSeen: async () => {
        await preferences?.update({ closeToTrayHintSeen: true })
      },
    })
    if (!pluginDevelopmentInstance) {
      const createdTrayManager = createTrayManager()
      createdTrayManager.create()
      trayManager = createdTrayManager
    }
    const startupPreferences = await preferences.read()
    logStartupStep('startup-preferences-read', 'completed')
    try {
      popoutShortcut?.configure(resolvePopoutShortcut(startupPreferences))
    } catch (error) {
      console.warn('[popout-window] failed to register global shortcut', error)
    }
    await createWindow(
      resolveStartupSplashTheme(startupPreferences.appearanceMode, nativeTheme.shouldUseDarkColors)
    )
    void startDesktopRuntime()
  })
}

function reportLogCleanup(result: LogCleanupResult): void {
  if (result.removedFiles > 0) {
    console.info('[logs] retention cleanup completed', {
      remainingBytes: result.remainingBytes,
      removedBytes: result.removedBytes,
      removedFiles: result.removedFiles,
      scannedFiles: result.scannedFiles,
    })
  }
  if (result.failures.length > 0) {
    console.warn('[logs] retention cleanup had failures', {
      failureCount: result.failures.length,
    })
  }
}

async function desktopEnvironment(): Promise<NodeJS.ProcessEnv> {
  const resourcesRoot = packagedApplication ? process.resourcesPath : developmentResourcesRoot
  const configuredComponentResourcesRoot = process.env.WEWORK_COMPONENT_RESOURCES_ROOT?.trim()
  const componentResourcesRoot =
    !packagedApplication && configuredComponentResourcesRoot
      ? resolve(configuredComponentResourcesRoot)
      : resourcesRoot
  const preparedComponents = await prepareDesktopComponents({
    isPackaged: packagedApplication,
    managerOptions: {
      resourcesRoot: componentResourcesRoot,
      dataDirectory: app.getPath('userData'),
      updateBaseUrl,
      currentAppVersion: app.getVersion(),
    },
  })
  componentUpdates = preparedComponents.manager
  const components = preparedComponents.paths
  const developmentRuntimeRoot = resolve(
    packageRoot,
    '..',
    'node_modules',
    '.cache',
    'harness-runtime-dev'
  )
  const configuredRuntimeRoot = process.env.WEWORK_HARNESS_RUNTIME_ROOT?.trim()
  const runtimeRoot = configuredRuntimeRoot
    ? configuredRuntimeRoot
    : components
      ? await materializeBundledRuntimes(components.coreDsh, packagedHarnessRuntimePaths().cache, [
          'core',
        ])
      : developmentRuntimeRoot
  const nodeRuntime = await electronNodeRuntime()
  const cliBin = join(app.getPath('userData'), 'runtime', 'wework-cli-bin')
  await installWeworkCli(
    cliBin,
    resolve(packageRoot, 'dist', 'cli', 'wework-cli.mjs'),
    process.platform,
    {
      appCommand: weworkCliAppCommand(),
      nodeCommand: [nodeRuntime.status.path],
    }
  )
  if (
    shouldInstallUserWeworkCli(process.platform, {
      environment: process.env,
      packagedApplication,
      pluginDevelopmentInstance,
    })
  ) {
    const userCliBin = join(app.getPath('home'), '.local', 'bin')
    const userCliPath = join(userCliBin, 'wework')
    if (await canReplaceWeworkCli(userCliPath)) {
      await installWeworkCli(
        userCliBin,
        resolve(packageRoot, 'dist', 'cli', 'wework-cli.mjs'),
        process.platform,
        {
          appCommand: weworkCliAppCommand(),
          nodeCommand: [nodeRuntime.status.path],
        }
      )
    } else {
      console.warn(`Wework CLI install path is not managed by Wework: ${userCliPath}`)
    }
  }
  nodeRuntime.environment.PATH = [cliBin, nodeRuntime.environment.PATH?.trim()]
    .filter(Boolean)
    .join(delimiter)
  return applyBrandRuntimeEnvironment(
    {
      ...nodeRuntime.environment,
      WEWORK_HARNESS_RUNTIME_ROOT: runtimeRoot,
      ...(components
        ? {
            WEWORK_HARNESS_RESOURCE_ROOT: components.coreDsh,
            WEWORK_CORE_PLUGIN_ROOT: components.weworkCorePlugins,
            WEWORK_CORE_PLUGINS_SHA256: components.contentSha256.weworkCorePlugins,
          }
        : {}),
      WEGENT_BUNDLED_PLUGIN_MARKETPLACE_DIR: join(
        components?.bundledPlugins ?? join(componentResourcesRoot, 'bundled-plugins'),
        'wework-personal'
      ),
      ...(process.env.WEWORK_EXECUTOR_PATH?.trim() || !components
        ? {}
        : existsSync(components.executor)
          ? { WEWORK_EXECUTOR_PATH: components.executor }
          : {}),
      ...(process.env.CODEX_BINARY_PATH?.trim() || !components || !existsSync(components.codex)
        ? {}
        : { CODEX_BINARY_PATH: components.codex, CODEX_BIN: components.codex }),
      ...(process.env.DWS_BINARY_PATH?.trim() || !components || !existsSync(components.dws)
        ? {}
        : { DWS_BINARY_PATH: components.dws }),
    },
    packageMetadata,
    app.getPath('home')
  )
}

function weworkCliAppCommand(): string[] {
  return packagedApplication ? [process.execPath] : [process.execPath, packageRoot]
}

function desktopControlRegistryDirectory(): string {
  return (
    process.env.WEWORK_DESKTOP_CONTROL_REGISTRY_DIR?.trim() ||
    join(app.getPath('home'), '.wework', 'runtime', 'desktop-instances')
  )
}

function desktopControlInstanceId(): string {
  const developmentId = process.env.WEWORK_DEV_INSTANCE_LABEL?.trim()
  if (pluginDevelopmentInstance && developmentId) {
    return `plugin-development-${developmentId}`
  }
  const identity = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 12)
  return `main-${identity}`
}

function electronNodeRuntime(): Promise<ElectronNodeRuntime> {
  electronNodeRuntimePromise ??= (async () => {
    const nodePath = await configuredNodePath()
    return prepareElectronNodeRuntime({
      dataDirectory: app.getPath('userData'),
      environment: {
        ...process.env,
        ...(nodePath ? { WEWORK_NODE_PATH: nodePath } : {}),
      },
      helperExecPath: (process as NodeJS.Process & { helperExecPath: string }).helperExecPath,
      nodeVersion: nodePath ? await readNodeVersion(nodePath) : process.versions.node,
      platform: process.platform,
    })
  })()
  return electronNodeRuntimePromise
}

async function configuredNodePath(): Promise<string | null> {
  return resolveConfiguredNodePath(await requiredPreferences().read(), process.env)
}

async function readNodeVersion(path: string): Promise<string> {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const { stdout } = await execFileAsync(path, ['--version'], {
    env: environment,
    timeout: 5000,
  })
  const output = stdout.trim()
  const match = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(output)
  if (!match) throw new Error(`Selected executable is not Node.js: ${path}`)
  return match[1]
}

function requiredPreferences(): PreferencesStore {
  if (!preferences) throw new Error('Desktop preferences are unavailable')
  return preferences
}

function requiredCloudCredentials(): CloudCredentialService {
  if (!cloudCredentials) throw new Error('Desktop cloud credentials are unavailable')
  return cloudCredentials
}

function requiredStartupRecovery(): StartupRecoveryService {
  if (!startupRecovery) throw new Error('Startup recovery is unavailable')
  return startupRecovery
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CloudCredentialError('request_failed', `${name} must be a non-empty string`)
  }
  return value.trim()
}

function cloudCredentialFailure(error: unknown): {
  ok: false
  error: { code: string; message: string; status: number | null }
} {
  const credentialError =
    error instanceof CloudCredentialError
      ? error
      : new CloudCredentialError(
          'request_failed',
          error instanceof Error ? error.message : String(error)
        )
  return {
    ok: false,
    error: {
      code: credentialError.code,
      message: credentialError.message,
      status: credentialError.status,
    },
  }
}

function packagedHarnessRuntimePaths(): { cache: string } {
  return {
    cache: join(app.getPath('userData'), 'managed-runtimes', 'dsh'),
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (keepE2EWindowInBackground && !e2eForegroundActivationAllowed) return
  void reactivateMainWindow().catch(error => {
    console.error('[window] failed to reactivate main window', error)
  })
})

app.on('did-become-active', () => {
  if (keepE2EWindowInBackground && !e2eForegroundActivationAllowed) {
    app.hide()
    return
  }
  if (mainWindow?.isVisible()) return
  void reactivateMainWindow().catch(error => {
    console.error('[window] failed to restore inactive main window', error)
  })
})

app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  requestApplicationShutdown(() => app.quit())
})

app.on('quit', () => {
  // Electron can finish every JS lifecycle event yet remain stuck in native teardown on
  // physical macOS 26.0-26.4 hosts (electron/electron#52582). Runtime cleanup has already
  // completed before app.quit() reaches this event, so terminate only the stranded host.
  if (requiresMacosQuitWorkaround(process.platform, release())) {
    process.kill(process.pid, 'SIGKILL')
  }
})

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(signal, () => {
    requestApplicationShutdown(() => app.exit(0))
  })
}
