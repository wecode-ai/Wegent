import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  shell,
  Tray,
  WebContentsView,
  webContents,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import electronUpdater from 'electron-updater'
import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  captureWebContentsDataUrl,
  createElectronCapabilityRouter,
} from './host/electron-capabilities.js'
import { HostPipeServer } from './host/host-pipe.js'
import { requiresMacosQuitWorkaround } from './host/macos-quit-workaround.js'
import { RendererHealthService } from './host/renderer-health.js'
import { SmartAppManager, type SmartAppRuntimeHost } from './host/smart-app-manager.js'
import { SystemSleepController } from './host/system-sleep-controller.js'
import { PreferencesStore } from './host/preferences-store.js'
import {
  EMBEDDED_BROWSER_PARTITION,
  EMBEDDED_BROWSER_ROUTE_HOST_SEPARATOR,
  EMBEDDED_BROWSER_ROUTE_PARTITION_PREFIX,
  EmbeddedBrowserManager,
} from './host/embedded-browser-manager.js'
import { EmbeddedBrowserBridge } from './host/embedded-browser-bridge.js'
import { materializeBundledRuntimes } from './runtime/bundled-runtime-materializer.js'
import {
  WorkbenchTabController,
  type WorkbenchTabView,
  type WorkbenchViewBounds,
} from './host/workbench-tab-controller.js'
import { waitForRendererSelector } from './host/renderer-readiness.js'
import { desktopWindowFrameOptions, workbenchDshBounds } from './host/window-layout.js'
import { createSingleFlight, presentWindow } from './host/window-presentation.js'
import { DesktopRuntime } from './runtime/desktop-runtime.js'
import { FeedbackBundleManager } from './host/feedback-bundle-manager.js'
import { WorkbenchPluginManager } from './host/workbench-plugin-manager.js'
import {
  resolveStartupSplashTheme,
  StartupSplash,
  type StartupSplashTheme,
} from './host/startup-splash.js'
import { ElectronTrayManager, type TrayAction } from './host/tray-manager.js'
import { createTrayIcon } from './host/tray-icon.js'
import { TrayNativeStatusController } from './host/tray-native-status.js'
import { WindowClosePolicy, type WindowCloseDecision } from './host/window-close-policy.js'
import { AppUpdateService } from './host/app-update-service.js'
import { installNativeContextMenu } from './host/image-context-menu.js'
import {
  cleanupStaleTemporaryImages,
  materializeTemporaryImage,
  resolveRendererImageContext,
  scheduleTemporaryImageCleanup,
} from './host/image-context-actions.js'
import { SystemResumeBridge } from './host/system-resume-bridge.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshPreloadPath = resolve(packageRoot, 'dist/dsh-preload.cjs')
const developmentResourcesRoot = resolve(packageRoot, '..', 'resources')
const { autoUpdater } = electronUpdater
const updateBaseUrl =
  process.env.WEWORK_UPDATE_BASE_URL?.trim() ||
  'https://github.com/wecode-ai/Wegent/releases/download/wework-updater'

const userDataPath =
  process.env.WEWORK_USER_DATA_DIR?.trim() || join(app.getPath('appData'), 'io.wecode.wework')
app.setPath('userData', resolve(userDataPath))

let mainWindow: BrowserWindow | null = null
const workspaceWindows = new Map<string, BrowserWindow>()
const dshWindowLabels = new Map<number, string>()
let attachedDshView: WebContentsView | null = null
let primaryDshLoaded = false
let primaryDshSecurityInstalled = false
let desktopRuntime: DesktopRuntime | null = null
let workbenchTabs: WorkbenchTabController<ElectronWorkbenchView> | null = null
let smartApps: SmartAppManager | null = null
let embeddedBrowser: EmbeddedBrowserManager | null = null
let embeddedBrowserBridge: EmbeddedBrowserBridge | null = null
let workbenchPlugins: WorkbenchPluginManager | null = null
let systemDragWindow: BrowserWindow | null = null
let popoutWindow: BrowserWindow | null = null
let popoutWindowCreationPromise: Promise<BrowserWindow> | null = null
let popoutWindowReadyPromise: Promise<void> | null = null
let systemDragContext: { conversationTitle: string | null } = { conversationTitle: null }
let pendingSystemDrops: Array<{
  action: 'new-chat' | 'follow-up' | 'stash'
  text: string | null
  paths: string[]
}> = []
let runtimeError: string | null = null
let runtimePhase: 'initializing' | 'ready' | 'failed' = 'initializing'
let runtimeStartPromise: Promise<void> | null = null
let quitting = false
let shutdownPromise: Promise<void> | null = null
let mainWindowCloseRequestRevision = 0
let dockVisible = true
let preferences: PreferencesStore | null = null
let windowClosePolicy: WindowClosePolicy | null = null
let startupSplash: StartupSplash | null = null
let trayManager: ElectronTrayManager<Electron.Menu | null, Tray> | null = null
let trayNativeStatus: TrayNativeStatusController | null = null
let pendingTrayActions: TrayAction[] = []
const pendingEmbeddedBrowserAttachments = new Map<
  number,
  Array<{ label: string; partition: string }>
>()
const rendererHealth = new RendererHealthService()
const systemSleep = new SystemSleepController()
const appUpdates = new AppUpdateService({
  updater: autoUpdater,
  currentVersion: () => app.getVersion(),
  isPackaged: () => app.isPackaged,
  prepareInstall: prepareApplicationShutdown,
  updateBaseUrl,
})
const systemResume = new SystemResumeBridge(powerMonitor, () => webContents.getAllWebContents())
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

rendererHealth.on('change', () => {
  mainWindow?.webContents.send('runtime:changed')
})

function secureDshContents(contents: WebContents, dshUrl: string): void {
  const allowedOrigin = new URL(dshUrl).origin
  installNativeContextMenu(
    contents,
    items => Menu.buildFromTemplate(items),
    {
      copyPath: path => clipboard.writeText(path),
      openImage: async image => {
        const temporaryPath = image.localPath
          ? null
          : await materializeTemporaryImage(contents, image)
        const path = image.localPath ?? temporaryPath
        if (!path) throw new Error('Image path is unavailable')
        const error = await shell.openPath(path)
        if (temporaryPath) scheduleTemporaryImageCleanup(temporaryPath)
        if (error) throw new Error(error)
      },
      reportError: (action, error) => {
        console.error(`[context-menu] ${action} failed`, error)
      },
      resolveImageContext: params => resolveRendererImageContext(contents, params),
      showItemInFolder: path => shell.showItemInFolder(path),
    },
    app.getLocale()
  )
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
    delete webPreferences.preload
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
  })
  contents.once('destroyed', () => pendingEmbeddedBrowserAttachments.delete(contents.id))
}

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

function secureDshView(view: WebContentsView, dshUrl: string): void {
  secureDshContents(view.webContents, dshUrl)
}

function layoutPrimaryView(): void {
  workbenchTabs?.layout()
  embeddedBrowser?.layoutAll()
}

function workbenchViewBounds(): WorkbenchViewBounds {
  const [width, height] = mainWindow?.getContentSize() ?? [0, 0]
  return workbenchDshBounds({ width, height })
}

function showWorkbenchView(view: WebContentsView | null): void {
  if (!mainWindow || attachedDshView === view) return
  if (attachedDshView) {
    mainWindow.contentView.removeChildView(attachedDshView)
  }
  attachedDshView = view
  if (view) {
    mainWindow.contentView.addChildView(view)
    view.setBounds(workbenchViewBounds())
  }
}

class ElectronWorkbenchView implements WorkbenchTabView {
  readonly nativeView: WebContentsView

  constructor() {
    this.nativeView = new WebContentsView({
      webPreferences: {
        backgroundThrottling: false,
        preload: dshPreloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
  }

  load(url: string): Promise<void> {
    secureDshView(this.nativeView, url)
    return this.nativeView.webContents.loadURL(url)
  }

  setBounds(bounds: WorkbenchViewBounds): void {
    this.nativeView.setBounds(bounds)
  }

  evaluate(expression: string): Promise<unknown> {
    return this.nativeView.webContents.executeJavaScript(expression, true)
  }

  capture(): Promise<string> {
    return captureWebContentsDataUrl(this.nativeView.webContents)
  }

  close(): void {
    if (attachedDshView === this.nativeView) showWorkbenchView(null)
    if (!this.nativeView.webContents.isDestroyed()) {
      this.nativeView.webContents.close()
    }
  }

  onRendererGone(listener: (reason: string) => void): () => void {
    const handler = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) =>
      listener(details.reason)
    this.nativeView.webContents.on('render-process-gone', handler)
    return () => {
      if (!this.nativeView.webContents.isDestroyed()) {
        this.nativeView.webContents.off('render-process-gone', handler)
      }
    }
  }
}

const loadPrimaryDshView = createSingleFlight(async (): Promise<void> => {
  if (!mainWindow || !desktopRuntime) return
  if (primaryDshLoaded) return
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
    mainWindow?.show()
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
    await startupSplash?.close({
      capturePath: process.env.WEWORK_E2E_STARTUP_SPLASH_CAPTURE?.trim(),
    })
    await contents.loadURL(dshUrl, {
      extraHeaders: 'X-Wework-Window-Label: main',
    })
  } catch (error) {
    primaryDshLoaded = false
    rendererHealth.failed('renderer_load_failed')
    throw error
  }
})

function disposeCoreDshViews(): void {
  for (const workspaceWindow of workspaceWindows.values()) {
    if (!workspaceWindow.isDestroyed()) workspaceWindow.destroy()
  }
  workspaceWindows.clear()
  systemDragWindow?.destroy()
  systemDragWindow = null
  popoutWindow?.destroy()
  popoutWindow = null
  popoutWindowCreationPromise = null
  popoutWindowReadyPromise = null
  primaryDshLoaded = false
}

function scheduleCoreDshRestart(): void {
  setTimeout(() => {
    void (async () => {
      if (!desktopRuntime) throw new Error('Core desktop runtime is unavailable')
      runtimePhase = 'initializing'
      runtimeError = null
      rendererHealth.loading()
      notifyRuntimeChanged()
      disposeCoreDshViews()
      await mainWindow?.webContents.loadURL('about:blank')
      await desktopRuntime.restartCoreDsh()
      await loadPrimaryDshView()
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
    backgroundColor: '#101316',
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
  if (kind === 'popout-window' && popoutWindowCreationPromise) {
    return popoutWindowCreationPromise
  }
  const creationPromise = createAuxiliaryWindow(kind)
  if (kind === 'system-drag-panel') return creationPromise
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
  const target = new URL(isSystemDrag ? 'system-drag' : 'popout', desktopRuntime.coreDshUrl())
  const auxiliaryWindow = new BrowserWindow({
    width: isSystemDrag ? 440 : 470,
    height: isSystemDrag ? 60 : 112,
    resizable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: isSystemDrag,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      backgroundThrottling: false,
      preload: dshPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  secureDshContents(auxiliaryWindow.webContents, desktopRuntime.coreDshUrl())
  registerDshWindowLabel(auxiliaryWindow.webContents, kind)
  auxiliaryWindow.on('closed', () => {
    if (kind === 'system-drag-panel') systemDragWindow = null
    else {
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
      systemDragWindow = auxiliaryWindow
    } else {
      popoutWindow = auxiliaryWindow
      readinessPromise = waitForRendererSelector(
        auxiliaryWindow.webContents,
        '[data-testid="popout-workbench-page"]'
      )
      popoutWindowReadyPromise = readinessPromise
      void readinessPromise.catch(() => {})
    }
    return auxiliaryWindow
  } catch (error) {
    if (!auxiliaryWindow.isDestroyed()) auxiliaryWindow.destroy()
    throw error
  }
}

async function showSystemDragPanel(): Promise<void> {
  const target = await ensureAuxiliaryWindow('system-drag-panel')
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const x = Math.round(display.workArea.x + (display.workArea.width - 440) / 2)
  target.setPosition(x, display.workArea.y + 8)
  target.showInactive()
}

async function showPopoutWindow(): Promise<void> {
  const target = await ensureAuxiliaryWindow('popout-window')
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  target.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - 470) / 2),
    Math.round(display.workArea.y + (display.workArea.height - 112) / 2)
  )
  presentWindow(target)
}

async function createWindow(startupTheme: StartupSplashTheme): Promise<void> {
  mainWindow = new BrowserWindow({
    ...desktopWindowFrameOptions(),
    width: 1440,
    height: 960,
    title: 'Wework',
    backgroundColor: startupTheme === 'dark' ? '#101316' : '#fafafa',
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
  startupSplash = new StartupSplash({
    window: {
      isDestroyed: () => mainWindow?.isDestroyed() ?? true,
      isVisible: () => mainWindow?.isVisible() ?? false,
      once: (event, listener) => {
        if (event === 'closed') mainWindow?.once('closed', listener)
        else mainWindow?.once('ready-to-show', listener)
      },
      show: () => mainWindow?.show(),
      webContents: {
        capturePage: async () => {
          if (!mainWindow) throw new Error('Main window is unavailable')
          return mainWindow.webContents.capturePage()
        },
        executeJavaScript: async code => {
          if (!mainWindow) throw new Error('Main window is unavailable')
          return mainWindow.webContents.executeJavaScript(code)
        },
        isDestroyed: () => mainWindow?.webContents.isDestroyed() ?? true,
      },
    },
    theme: startupTheme,
  })
  const startupShown = startupSplash.show()
  mainWindow.on('resize', layoutPrimaryView)
  mainWindow.on('close', event => {
    if (quitting) return
    event.preventDefault()
    void handleMainWindowCloseRequest()
  })
  mainWindow.on('closed', () => {
    attachedDshView = null
    primaryDshLoaded = false
    primaryDshSecurityInstalled = false
    mainWindow = null
  })
  await mainWindow.loadFile(resolve(packageRoot, 'dist/shell/index.html'), {
    query: { theme: startupTheme },
  })
  await startupShown
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
      mainWindowCloseRequestRevision += 1
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
  console.log(`windowWillClose: electron close-to-tray revision=${mainWindowCloseRequestRevision}`)
  target.hide()
  if (process.platform === 'darwin') {
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
  const target = mainWindow
  if (!target || target.isDestroyed()) return
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
    pendingTrayActions.push(action)
  }
}

function createTrayManager(): ElectronTrayManager<Electron.Menu | null, Tray> {
  const resourcesRoot = app.isPackaged ? process.resourcesPath : developmentResourcesRoot
  const iconPath = join(resourcesRoot, 'icons', '128x128.png')
  return new ElectronTrayManager({
    createTray: () => new Tray(createTrayIcon(nativeImage, iconPath)),
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
}

async function shutdown(): Promise<void> {
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
  systemDragWindow?.destroy()
  systemDragWindow = null
  popoutWindow?.destroy()
  popoutWindow = null
  popoutWindowCreationPromise = null
  popoutWindowReadyPromise = null
  embeddedBrowser?.stop()
  const plugins = workbenchPlugins
  workbenchPlugins = null
  const browserBridge = embeddedBrowserBridge
  embeddedBrowserBridge = null
  await Promise.allSettled([
    browserBridge?.stop(),
    plugins?.shutdown(),
    workbenchTabs?.stop(),
    desktopRuntime?.stop(),
  ])
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
  if (!workbenchTabs) return null
  return {
    open: async launch => {
      await workbenchTabs?.open(launch)
    },
    close: tabId => workbenchTabs?.close(tabId) ?? Promise.resolve(),
    activate: tabId => workbenchTabs?.activate(tabId),
    runningTabIds: () => new Set(workbenchTabs?.list().map(item => item.tabId) ?? []),
  }
}

async function configureDesktopRuntime(): Promise<void> {
  if (desktopRuntime) return
  const environment = await desktopEnvironment()
  if (!preferences) throw new Error('Desktop preferences are unavailable')
  workbenchPlugins = new WorkbenchPluginManager()
  const feedback = new FeedbackBundleManager({
    appVersion: () => app.getVersion(),
    cacheDirectory: join(app.getPath('userData'), 'cache'),
    downloadsDirectory: app.getPath('downloads'),
    logDirectories: [app.getPath('logs')],
  })
  embeddedBrowser = new EmbeddedBrowserManager(app.getPath('userData'))
  embeddedBrowserBridge = new EmbeddedBrowserBridge(
    embeddedBrowser,
    process.env.WEGENT_EXECUTOR_HOME?.trim() || join(app.getPath('home'), '.wework')
  )
  await embeddedBrowserBridge.start()
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
        app.isPackaged && !process.env.WEWORK_HARNESS_RUNTIME_ROOT?.trim()
          ? async () => {
              const paths = packagedHarnessRuntimePaths()
              await materializeBundledRuntimes(paths.resources, paths.cache, ['workbench'])
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
        embeddedBrowser,
        {
          coreDshPlugins: () => desktopRuntime,
          appUpdates,
          feedback,
          plugins: workbenchPlugins,
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
          closeRequestState: after => ({
            requested: mainWindowCloseRequestRevision > after,
            revision: mainWindowCloseRequestRevision,
          }),
          cancelCloseToTray: cancelMainWindowClose,
          closeToTray: closeMainWindowToTray,
          focusWindow: windowLabel => {
            const target =
              windowLabel === 'main' ? mainWindow : (workspaceWindows.get(windowLabel) ?? null)
            if (target) presentWindow(target)
          },
          hideMainWindow: hideMainWindowToBackground,
          dockVisible: () => dockVisible,
          startupSplashSnapshot: () => startupSplash?.snapshot() ?? null,
          trayActivate: activation => trayManager?.activate(activation) ?? false,
          traySetState: state => {
            trayManager?.setState(state)
            void trayNativeStatus?.refresh()
          },
          traySnapshot: () => trayManager?.snapshot() ?? null,
          takePendingTrayActions: () => {
            const actions = pendingTrayActions
            pendingTrayActions = []
            return actions
          },
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
          captureWorkbench: tabId => {
            if (!workbenchTabs) throw new Error('Workbench tabs are unavailable')
            return workbenchTabs.capture(tabId)
          },
          completeSystemDragDrop: async payload => {
            pendingSystemDrops.push(payload)
            await showPopoutWindow()
          },
          dismissPopout: () => popoutWindow?.hide(),
          dismissSystemDragPanel: () => systemDragWindow?.hide(),
          evaluateWorkbench: (tabId, expression) => {
            if (!workbenchTabs) throw new Error('Workbench tabs are unavailable')
            return workbenchTabs.evaluate(tabId, expression)
          },
          getSystemDragContext: () => systemDragContext,
          runtimeDiagnostics: () =>
            desktopRuntime?.diagnostics() ?? {
              coreDshPid: null,
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
          showSystemDragPanel,
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
  workbenchTabs = new WorkbenchTabController({
    runtime: desktopRuntime,
    surface: {
      bounds: workbenchViewBounds,
      show: view => showWorkbenchView(view?.nativeView ?? null),
    },
    createView: () => new ElectronWorkbenchView(),
  })
  workbenchTabs.on('change', () => {
    mainWindow?.webContents.send('runtime:changed')
  })
}

function notifyRuntimeChanged(): void {
  mainWindow?.webContents.send('runtime:changed')
}

function startDesktopRuntime(): Promise<void> {
  if (runtimeStartPromise) return runtimeStartPromise
  runtimePhase = 'initializing'
  runtimeError = null
  notifyRuntimeChanged()
  runtimeStartPromise = (async () => {
    await configureDesktopRuntime()
    await desktopRuntime?.start()
    trayNativeStatus?.start()
    await loadPrimaryDshView()
    runtimePhase = 'ready'
  })()
    .catch(error => {
      runtimePhase = 'failed'
      runtimeError = error instanceof Error ? error.message : String(error)
      console.error('[runtime] startup failed', error)
      mainWindow?.show()
      void startupSplash?.close().catch(splashError => {
        console.error('[startup-splash] failed to close after runtime failure', splashError)
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
    await cleanupStaleTemporaryImages().catch(error => {
      console.error('[context-menu] failed to remove stale temporary images', error)
    })
    installDshWindowLabelHeaders()
    installIpc()
    systemResume.start()
    preferences = new PreferencesStore(app.getPath('userData'))
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
    const createdTrayManager = createTrayManager()
    createdTrayManager.create()
    trayManager = createdTrayManager
    const startupPreferences = await preferences.read()
    await createWindow(
      resolveStartupSplashTheme(startupPreferences.appearanceMode, nativeTheme.shouldUseDarkColors)
    )
    void startDesktopRuntime()
  })
}

async function desktopEnvironment(): Promise<NodeJS.ProcessEnv> {
  const resourcesRoot = app.isPackaged ? process.resourcesPath : developmentResourcesRoot
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
    : app.isPackaged
      ? await materializeBundledRuntimes(
          packagedHarnessRuntimePaths().resources,
          packagedHarnessRuntimePaths().cache,
          ['core']
        )
      : developmentRuntimeRoot
  const executorName = process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
  const packagedExecutor = join(resourcesRoot, 'bin', executorName)
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const packagedNode = join(resourcesRoot, 'node-runtime', 'bin', nodeName)
  const nodePath =
    process.env.WEWORK_NODE_PATH?.trim() ||
    (existsSync(packagedNode) ? packagedNode : process.execPath)
  return {
    ...process.env,
    WEWORK_HARNESS_RUNTIME_ROOT: runtimeRoot,
    WEWORK_NODE_PATH: nodePath,
    WEGENT_BUNDLED_PLUGIN_MARKETPLACE_DIR: join(
      resourcesRoot,
      'bundled-plugins',
      'wework-personal'
    ),
    ...(process.env.WEWORK_EXECUTOR_PATH?.trim()
      ? {}
      : existsSync(packagedExecutor)
        ? { WEWORK_EXECUTOR_PATH: packagedExecutor }
        : {}),
    ...(nodePath === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }
}

function packagedHarnessRuntimePaths(): { resources: string; cache: string } {
  return {
    resources: join(process.resourcesPath, 'harness-runtime'),
    cache: join(app.getPath('userData'), 'managed-runtimes', 'dsh'),
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  void reactivateMainWindow().catch(error => {
    console.error('[window] failed to reactivate main window', error)
  })
})

app.on('did-become-active', () => {
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
