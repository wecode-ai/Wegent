import { ModelConfigurationStore } from './host/model-configuration-store.js'
import { ModelRuntimeRequest } from './host/model-runtime-request.js'
import { CloudModelRuntime } from './host/cloud-model-runtime.js'
import {
  LOCAL_PROXY_SETTINGS_STORAGE_KEY,
  storedLocalProxyConfig,
  normalizeLocalProxyUrl,
} from './shared/local-proxy-config.js'
import { confirmCoreDshPluginInstall } from './host/core-dsh-plugin-approval.js'
import { McpAppRuntime } from './host/mcp-app-runtime.js'
import {
  readCloudConnection,
  requireCloudCredentialOwner,
} from './host/cloud-connection-profile.js'
import { settleMcpAppCleanup } from './host/mcp-app-sessions.js'
import './host/process-output-bootstrap.js'
import { MCP_APP_SCHEME } from './host/mcp-app-documents.js'
import { SchemeQueue } from './host/scheme-queue.js'
import { RuntimeDiagnosticsLog } from './host/runtime-diagnostics-log.js'
import { buildStartupDiagnostics, type StartupFailureSnapshot } from './host/startup-diagnostics.js'
import { startupFailureSnapshot } from './host/startup-failure.js'
import {
  clickStartupSplash,
  inspectStartupSplash,
  observeStartupSplash,
} from './host/startup-splash-verification.js'
import { mainProcessLog } from './host/main-process-log.js'
import { desktopE2EStartupTiming, StartupProgressReporter } from './host/startup-progress.js'
import { recordReleaseDiagnostic } from './runtime/release-diagnostics.js'
import { traceShutdownStep } from './runtime/shutdown-diagnostics.js'
import { installE2ERendererCpuProfiling } from './host/e2e-renderer-cpu-profile.js'
import { VerificationDevtools } from './host/verification-devtools.js'

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  Tray,
  webContents,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type Session,
  type WebContents,
} from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  captureWebContentsDataUrl,
  createElectronCapabilityRouter,
  WEWORK_WORKBENCH_PRINCIPAL,
  createWorkbenchCapabilityRouter,
} from './host/electron-capabilities.js'
import { HostPipeServer } from './host/host-pipe.js'
import { DesktopHostEventBroker } from './host/desktop-host-events.js'
import { StartupTelemetryLifecycle, StartupTelemetrySuccessGate } from './host/startup-telemetry.js'
import { requiresMacosQuitWorkaround } from './host/macos-quit-workaround.mjs'
import { RendererHealthService } from './host/renderer-health.js'
import { RendererStartupLoader } from './host/renderer-startup-loader.js'
import { installStartupNetworkFault } from './host/e2e-startup-network-fault.js'
import { SmartAppManager, type SmartAppRuntimeHost } from './host/smart-app-manager.js'
import { resolveDownloadsDirectory } from './host/downloads-directory.js'
import { SystemSleepController } from './host/system-sleep-controller.js'
import { PreferencesStore } from './host/preferences-store.js'
import { DesktopAppearanceController } from './host/appearance-theme.js'
import { normalizeAppearanceThemeSnapshot } from './host/appearance-theme-contract.js'
import {
  DesktopPreferencesController,
  resolvePopoutShortcut,
} from './host/desktop-preferences-controller.js'
import { PerformanceRecorder } from './host/performance-recorder.js'
import {
  initializeWorkbenchModePreference,
  normalizeWorkbenchMode,
} from './runtime/workbench-mode.js'
import type { RendererStorageStore } from './host/renderer-storage-store.js'
import { createDesktopRendererStorage } from './host/desktop-renderer-storage.js'
import {
  EMBEDDED_BROWSER_PARTITION,
  EMBEDDED_BROWSER_ROUTE_HOST_SEPARATOR,
  EMBEDDED_BROWSER_ROUTE_PARTITION_PREFIX,
  EmbeddedBrowserManager,
} from './host/embedded-browser-manager.js'
import { EmbeddedBrowserBridge } from './host/embedded-browser-bridge.js'
import { WeworkDesktopControlBridge } from './host/wework-desktop-control-bridge.js'
import { requestE2ERuntime } from './host/e2e-runtime-request.js'
import {
  dshBrowserAuthenticationCookies,
  dshBrowserRequestHeaders,
} from './runtime/dsh-browser-auth.js'
import { ComputerUseService } from './host/computer-use-service.js'
import { restoreComputerUseAfterStartup } from './host/computer-use-startup.js'
import { materializeBundledRuntimes } from './runtime/bundled-runtime-materializer.js'
import { waitForRendererSelector } from './host/renderer-readiness.js'
import { captureProcessExplorerWindowSnapshot } from './host/process-explorer-window-snapshot.js'
import { setE2EWindowSize } from './host/e2e-window-size.js'
import { desktopWindowFrameOptions, startupWindowLayout } from './host/window-layout.js'
import { MainWindowStateController } from './host/main-window-state.js'
import { prepareStartupMainWindow } from './host/startup-window-handoff.js'
import {
  POPOUT_WINDOW_SIZES,
  popoutWindowBounds,
  type PopoutWindowMode,
} from './host/popout-window-layout.js'
import {
  createSingleFlight,
  presentWindow,
  registerApplicationActivation,
} from './host/window-presentation.js'
import { handlePopoutWindowInput } from './host/popout-window-shortcuts.js'
import { createWeworkProcessExplorerService } from './host/process-explorer-service.js'
import { DesktopRuntime } from './runtime/desktop-runtime.js'
import { detectCoreDshStartupPluginFailure } from './host/core-dsh-startup-failure.js'
import { startStartupMaintenance } from './host/startup-tasks.js'
import { isolateDevelopmentEnvironment } from './runtime/development-isolation.js'
import { prepareDevelopmentHistory } from './runtime/development-history-migration.js'
import { FeedbackBundleManager } from './host/feedback-bundle-manager.js'
import {
  createStartupReadyHandler,
  resolveStartupSplashHoldMs,
  resolveStartupSplashTheme,
  StartupSplash,
  startupSplashBlocksMainWindowActivation,
  type StartupSplashTheme,
} from './host/startup-splash.js'
import { assertStartupRecoverySender, StartupRecoveryService } from './host/startup-recovery.js'
import {
  focusStartupRecoveryIfActive,
  showStartupRecovery,
} from './host/startup-recovery-window.js'
import { clearStartupRuntimeFiles, clearStartupUserFiles } from './host/startup-recovery-files.js'
import { activateTrayAction, ElectronTrayManager, type TrayAction } from './host/tray-manager.js'
import { createTrayIcon, trayIconFilename } from './host/tray-icon.js'
import { trayGuidForApplicationId } from './host/tray-guid.js'
import { openApplicationLogDirectory } from './host/application-log-directory.js'
import { TrayNativeStatusController } from './host/tray-native-status.js'
import { WindowClosePolicy, type WindowCloseDecision } from './host/window-close-policy.js'
import {
  ApplicationMenu,
  APPLICATION_MENU_ACTIONS,
  EMPTY_APPLICATION_MENU_CAPABILITIES,
  type ApplicationMenuAction,
  type ApplicationMenuCapabilityState,
} from './host/application-menu.js'
import { AppUpdateService } from './host/app-update-service.js'
import { ReleaseStore } from './runtime/release-store.js'
import { AppUpdateLogger } from './host/app-update-logger.js'
import { CloudCredentialError, CloudCredentialService } from './host/cloud-credential-service.js'
import { PluginNativeAuthorization } from './host/plugin-native-authorization.js'
import { cloudFetch } from './host/cloud-http.js'
import { installE2eDshReleaseRedirect } from './host/e2e-dsh-release-redirect.js'
import {
  cleanupStaleTemporaryImages,
  createNativeContextMenuActions,
  installContextMenu,
} from './host/image-context-actions.js'
import { resolveSystemProxy } from './host/system-proxy.js'
import { SystemResumeBridge } from './host/system-resume-bridge.js'
import {
  prepareDesktopComponents,
  type DesktopComponentUpdateController,
  type PreparedDesktopComponents,
} from './runtime/desktop-components.js'
import {
  prepareElectronNodeRuntime,
  resolveConfiguredNodePath,
  type ElectronNodeRuntime,
} from './runtime/electron-node-runtime.js'
import { PythonRuntimeManager } from './runtime/python-runtime.js'
import { desktopInstanceMayStart } from './runtime/plugin-development-command.js'
import {
  fetchPythonRuntimeDownloads,
  fetchParentPythonRuntimeDownloads,
  PythonRuntimeLoginRequiredError,
} from './runtime/python-runtime-downloads.js'
import type { BrandRuntimeMetadata } from './runtime/brand-runtime-environment.js'
import {
  prepareWorkbenchEnvironment,
  resolveWorkbenchPaths,
} from './runtime/workbench-environment.js'
import { migrateDesktopControlRegistry } from './runtime/workbench-desktop-data.js'
import { initializeWorkbenchDesktopData } from './runtime/workbench-desktop-startup.js'
import { executorMigrationLock } from './runtime/workbench-migration-lock.js'
import { assertExecutorWorkbenchCompatibility } from './runtime/workbench-executor-schema.js'
import { desktopE2EWindowOptions, keepDesktopE2EInBackground } from './host/e2e-window-policy.js'
import { desktopE2EApplicationName } from './host/e2e-application-name.js'
import {
  applyWorkbenchBackgroundPolicy,
  workbenchBackgroundThrottling,
} from './host/window-background-policy.js'
import { redactLog } from './runtime/rotating-log.js'
import { GlobalShortcutController } from './host/global-shortcut-controller.js'
import {
  isTrustedIsolatedSurfaceAttachment,
  loadTrustedIsolatedSurfacePolicies,
} from './host/isolated-surface-security.js'
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
import { protectedCredentialDirectory } from './host/credential-storage-paths.js'
import { resolveDevelopmentDockIdentity } from './host/development-dock-identity.js'
import { installedMacosReleaseResources } from './runtime/macos-release-installation.js'
import { syncDockBadge } from './host/dock-badge.js'
import { isEffectivePackagedApplication } from './host/application-packaging-mode.js'
import { normalizeWeworkSyncApiBaseUrl, requestWeworkSync } from './host/wework-sync-request.js'
import { fixedWorkspaceWindowDescriptors } from './host/fixed-workspace-window-restore.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: MCP_APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])
applyWorkbenchBackgroundPolicy(process.platform, app.commandLine)

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageMetadata = createRequire(import.meta.url)('../package.json') as {
  name: string
  weworkAppId?: string
  weworkProductName?: string
  weworkUpdateBaseUrl?: string
  weworkDataSchema?: number
  weworkReadableDataSchemas?: number[]
} & BrandRuntimeMetadata
if (packageMetadata.weworkProductName?.trim())
  app.setName(
    desktopE2EApplicationName(
      packageMetadata.weworkProductName.trim(),
      process.env,
      process.platform
    )
  )
const packagedApplication = isEffectivePackagedApplication(app.isPackaged, process.env)
isolateDevelopmentEnvironment(process.env, {
  packaged: packagedApplication,
  packageRoot,
  appData: app.getPath('appData'),
  homeDirectory: process.env.HOME?.trim() || app.getPath('home'),
})
const dshPreloadPath = resolve(packageRoot, 'dist/dsh-preload.cjs')
const startupSplashPreloadPath = resolve(packageRoot, 'dist/startup-splash-preload.cjs')
const browserAnnotationPreloadPath = resolve(packageRoot, 'dist/browser-annotation-preload.cjs')
const isolatedSurfacePreloadPath = resolve(packageRoot, 'dist/isolated-surface-preload.cjs')
const isolatedSurfacePolicies = loadTrustedIsolatedSurfacePolicies(
  resolve(packageRoot, 'dist/isolated-surfaces.json')
)
const developmentResourcesRoot = resolve(packageRoot, '..', 'resources')
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
const startupStartedAt = performance.now()
const pluginDevelopmentInstance = process.env.WEWORK_INSTANCE_MODE === 'core-dsh-plugin-development'
const pythonRuntimeEnabled = process.env.WEWORK_E2E_DISABLE_PYTHON_BOOTSTRAP !== '1'
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
  recordReleaseDiagnostic('startup-step', {
    step,
    status,
    elapsedMs: Math.round(performance.now() - startupStartedAt),
    errorType: details.errorType,
  })
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
let userDataPath = resolve(configuredUserDataPath || join(app.getPath('appData'), applicationId))
const desktopDataPaths =
  !configuredUserDataPath && packagedApplication
    ? resolveWorkbenchPaths({
        environment: process.env,
        metadata: packageMetadata,
        homeDirectory: app.getPath('home'),
      })
    : null
const singleInstanceData = {
  pluginDevelopmentCommand,
  workspaceOpenRequest: startupWorkspaceOpenRequest,
}
let hasSingleInstanceLock: boolean
if (desktopDataPaths) {
  try {
    const migrated = await initializeWorkbenchDesktopData({
      app,
      source: userDataPath,
      desktop: desktopDataPaths.desktop,
      additionalData: singleInstanceData,
      acquireLock: executorMigrationLock(
        process.env.WEWORK_EXECUTOR_PATH?.trim() ||
          join(process.resourcesPath, 'bin', 'wegent-executor.exe'),
        { wait: true }
      ),
    })
    hasSingleInstanceLock = migrated !== null
    if (migrated) {
      if (!process.env.WEWORK_DESKTOP_CONTROL_REGISTRY_DIR?.trim()) {
        try {
          migrateDesktopControlRegistry(
            process.env.HOME?.trim() || app.getPath('home'),
            desktopDataPaths.shared
          )
        } catch (error) {
          console.warn('[startup] desktop control registry migration failed', error)
        }
      }
      userDataPath = migrated.userData
      app.setPath('userData', userDataPath)
      app.setPath('sessionData', userDataPath)
      app.setAppLogsPath(migrated.logs)
    }
  } catch (error) {
    console.error('[startup] application data migration failed', error)
    throw error
  }
} else {
  app.setPath('userData', userDataPath)
  hasSingleInstanceLock = app.requestSingleInstanceLock(singleInstanceData)
  if (configuredUserDataPath) app.setAppLogsPath(join(userDataPath, 'logs'))
}

hasSingleInstanceLock = desktopInstanceMayStart(
  app,
  hasSingleInstanceLock,
  pluginDevelopmentCommand
)

let mainWindow: BrowserWindow | null = null
let mainWindowState: MainWindowStateController | null = null
let startupSplashWindow: BrowserWindow | null = null
await mainProcessLog.setPath(join(app.getPath('logs'), 'wework-main.log')).catch(error => {
  console.warn('[logs] failed to open main process log', error)
})
const workspaceWindows = new Map<string, BrowserWindow>()
const mcpAppCleanups = new Set<() => Promise<void>>()
let mcpAppRuntime: McpAppRuntime | null = null
let cloudModelRuntime: CloudModelRuntime | null = null
const dshWindowLabels = new Map<number, string>()
let applicationMenu: ApplicationMenu | null = null
let nativeDialogLanguage: string | undefined
let lastMenuWindow: BrowserWindow | null = null
const menuCapabilities = new Map<string, ApplicationMenuCapabilityState>()
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
let popoutWindowMode: PopoutWindowMode = 'composer'
let processExplorerWindow: BrowserWindow | null = null
const desktopAppearance = new DesktopAppearanceController({
  nativeTheme,
  windows: () => [mainWindow, processExplorerWindow, ...workspaceWindows.values()],
})
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
let pythonRuntimeManagerPromise: Promise<PythonRuntimeManager> | null = null
let quitting = false
let shutdownPromise: Promise<void> | null = null
let dockVisible = true
let e2eForegroundActivationAllowed = false
let preferences: PreferencesStore | null = null
let desktopPreferences: DesktopPreferencesController | null = null
let performanceRecorder: PerformanceRecorder | null = null
let rendererStorage: RendererStorageStore | null = null
let cloudCredentials: CloudCredentialService | null = null
const pluginNativeAuthorization = new PluginNativeAuthorization(
  requiredCloudCredentials,
  (method, params) =>
    desktopRuntime
      ? desktopRuntime.requestExecutor(method, params)
      : Promise.reject(new Error('Desktop runtime is unavailable'))
)
let windowClosePolicy: WindowClosePolicy | null = null
let startupSplash: StartupSplash | null = null
let startupSplashObserver: ReturnType<typeof observeStartupSplash> | null = null
let startupRecovery: StartupRecoveryService | null = null
let lastStartupFailure: StartupFailureSnapshot | null = null
const startupTiming = desktopE2EStartupTiming(process.env)
const startupProgress = new StartupProgressReporter(
  update => {
    logStartupStep('startup-progress', update.completed ? 'completed' : 'started', {
      stage: update.stage.id,
      index: update.index,
    })
    startupSplash?.updateProgress(update)
  },
  Date.now,
  startupTiming
)
let startupRuntimeEnvironment: NodeJS.ProcessEnv | null = null
let componentUpdates: DesktopComponentUpdateController | null = null
let desktopComponentsPromise: Promise<PreparedDesktopComponents> | null = null
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
        resumePythonAfterLogin: async () => {
          await pythonRuntimeManagerPromise?.then(runtime => runtime.resumeAfterLogin())
        },
        requestStop: () => requestApplicationShutdown(() => app.quit()),
        getCoreDshPid: () => desktopRuntime?.diagnostics().coreDshPid ?? null,
        isShuttingDown: () => quitting || !desktopRuntime,
      })
    : null
let trayManager: ElectronTrayManager<Electron.Menu | null, Tray> | null = null
let trayNativeStatus: TrayNativeStatusController | null = null
const desktopHostEvents = new DesktopHostEventBroker()
const startupTelemetry = new StartupTelemetryLifecycle({
  id: randomUUID(),
  now: () => performance.now(),
  publish: (type, payload) => {
    desktopHostEvents.publish(type, payload)
    if (type === 'startup.succeeded' && process.env.WEWORK_ACTIVE_RELEASE_ID) {
      const releases = new ReleaseStore(join(app.getPath('userData'), 'releases'))
      void releases
        .confirm(process.env.WEWORK_ACTIVE_RELEASE_ID)
        .catch(error => console.error('[release] failed to confirm startup', error))
    }
  },
})
const startupTelemetrySuccess = new StartupTelemetrySuccessGate(startupTelemetry)
startupTelemetry.start()
const pendingSchemes = new SchemeQueue()
process.argv.forEach(value => pendingSchemes.enqueue(value))

function queueScheme(url: string): void {
  if (!pendingSchemes.enqueue(url)) return
  desktopHostEvents.publish('wework-scheme-requested', {})
}

function openSchemeInMainWindow(url: string): void {
  queueScheme(url)
  void reactivateMainWindow().catch(error => {
    console.error('[navigation] failed to activate main window for scheme navigation', error)
  })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  queueScheme(url)
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
})

if (packagedApplication && !pluginDevelopmentInstance && !process.env.WEWORK_E2E_CONTROL_URL) {
  app.setAsDefaultProtocolClient('wework')
}
const pendingWorkspaceOpenRequests: LocalWorkspaceOpenRequest[] = startupWorkspaceOpenRequest
  ? [startupWorkspaceOpenRequest]
  : []
const pendingEmbeddedBrowserAttachments = new Map<
  number,
  Array<
    | { kind: 'browser'; label: string; partition: string }
    | { kind: 'isolated-surface'; partition: Session }
  >
>()
const rendererHealth = new RendererHealthService()
const rendererStartupLoader = new RendererStartupLoader()
const systemSleep = new SystemSleepController()
const appUpdateLogger = new AppUpdateLogger(join(app.getPath('logs'), 'app-update.log'))
const runtimeDiagnosticsLog = new RuntimeDiagnosticsLog(
  join(app.getPath('logs'), 'runtime-launch.log')
)
const executorTransportDiagnosticsLog = new RuntimeDiagnosticsLog(
  join(app.getPath('logs'), 'executor-transport.log'),
  '[Wework] Executor transport diagnostic '
)
const electronHostDiagnosticsLog = new RuntimeDiagnosticsLog(
  join(app.getPath('logs'), 'electron-host-transport.log'),
  '[Wework] Electron host diagnostic '
)
const smartAppDiagnosticsLog = new RuntimeDiagnosticsLog(
  join(app.getPath('logs'), 'smart-app-launch.log'),
  '[Wework] Smart app launch diagnostic '
)
const conversationSearchDiagnosticsLog = new RuntimeDiagnosticsLog(
  join(app.getPath('logs'), 'conversation-search.log'),
  '[Wework] Conversation search diagnostic '
)
const localWorkspaceCatalogLog = new RuntimeDiagnosticsLog(
  join(app.getPath('logs'), 'local-workspace-catalog.log'),
  '[Wework] Local workspace catalog '
)
app.on('web-contents-created', (_event, contents) => {
  const logLoadEvent = (event: string) => () => {
    const address = contents.getURL()
    const route =
      process.env.VITE_WEWORK_E2E === 'true' && URL.canParse(address) ? new URL(address) : null
    console.info('[renderer-load]', {
      event,
      webContentsId: contents.id,
      ...(route?.pathname.startsWith('/wework/app')
        ? {
            pathname: route.pathname,
            projectId: route.searchParams.get('projectId'),
            projectStore: route.searchParams.get('projectStore'),
            workspaceTab: route.searchParams.get('workspaceTab'),
          }
        : {}),
    })
  }
  if (process.env.VITE_WEWORK_E2E === 'true')
    contents.on('did-navigate-in-page', logLoadEvent('did-navigate-in-page'))
  contents.on('did-start-loading', logLoadEvent('did-start-loading'))
  contents.on('dom-ready', logLoadEvent('dom-ready'))
  contents.on('did-finish-load', logLoadEvent('did-finish-load'))
  contents.on('did-stop-loading', logLoadEvent('did-stop-loading'))
  contents.on('will-prevent-unload', logLoadEvent('will-prevent-unload'))
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    console.warn('[renderer-load]', {
      event: 'did-fail-load',
      webContentsId: contents.id,
      errorCode,
      errorDescription,
      isMainFrame,
    })
  })
  contents.on('console-message', (_event, level, message, lineNumber, sourceId) => {
    if (process.env.VITE_WEWORK_E2E === 'true' && message.startsWith('[desktop-e2e-key] ')) {
      console.info(redactLog(message).slice(0, 1024))
    }
    if (
      process.env.VITE_WEWORK_E2E === 'true' &&
      message.startsWith('[process-explorer-snapshot] ')
    ) {
      console.info('[process-explorer-renderer]', {
        webContentsId: contents.id,
        message: redactLog(message).slice(0, 1024),
      })
    }
    if (process.env.VITE_WEWORK_E2E === 'true' && message.startsWith('[interaction-focus-state]'))
      console.info(redactLog(message).slice(0, 4096))
    if (process.env.VITE_WEWORK_E2E === 'true' && level === 3) {
      recordReleaseDiagnostic('renderer-error', {
        message: redactLog(message).slice(0, 4096),
        sourcePath: URL.canParse(sourceId) ? redactLog(new URL(sourceId).pathname) : undefined,
      })
      console.warn('[renderer-error]', {
        webContentsId: contents.id,
        message: redactLog(message).slice(0, 4096),
        lineNumber,
        sourcePath: URL.canParse(sourceId) ? redactLog(new URL(sourceId).pathname) : undefined,
      })
    }
    // Keep renderer warnings and errors raised while the splash is still up;
    // they are startup evidence the main process cannot observe itself.
    if (level >= 2 && startupSplash?.snapshot().state !== 'closed') {
      const source = URL.canParse(sourceId) ? redactLog(new URL(sourceId).pathname) : sourceId
      void startupRendererLog
        .record(
          contents.id,
          `[renderer:${level === 3 ? 'error' : 'warning'}] ${source}:${lineNumber} ${message}`
        )
        .catch(error => {
          console.warn('[Wework] Failed to write startup renderer diagnostics', error)
        })
    }
    void runtimeDiagnosticsLog.record(contents.id, message).catch(error => {
      console.warn('[Wework] Failed to write runtime diagnostics', error)
    })
    void executorTransportDiagnosticsLog.record(contents.id, message).catch(error => {
      console.warn('[Wework] Failed to write executor transport diagnostics', error)
    })
    void electronHostDiagnosticsLog.record(contents.id, message).catch(error => {
      console.warn('[Wework] Failed to write Electron host diagnostics', error)
    })
    void smartAppDiagnosticsLog.record(contents.id, message).catch(error => {
      console.warn('[Wework] Failed to write Smart app diagnostics', error)
    })
    void conversationSearchDiagnosticsLog.record(contents.id, message).catch(error => {
      console.warn('[Wework] Failed to write conversation search diagnostics', error)
    })
    void localWorkspaceCatalogLog.record(contents.id, message).catch(() => {
      console.warn('[Wework] Failed to write local workspace catalog diagnostics')
    })
  })
})
const executorHome =
  process.env.WEGENT_EXECUTOR_HOME?.trim() ||
  desktopDataPaths?.desktop ||
  join(app.getPath('home'), '.wework')
const startupRendererLog = new RuntimeDiagnosticsLog(
  join(app.getPath('logs'), 'renderer-startup.log'),
  ''
)
const applicationLogDirectory = app.getPath('logs')
const configuredExecutorLogFile = process.env.WEGENT_EXECUTOR_LOG_FILE?.trim()
const runtimeLogDirectories = [
  app.getPath('logs'),
  join(executorHome, 'logs'),
  ...(process.env.WEGENT_EXECUTOR_LOG_DIR?.trim()
    ? [process.env.WEGENT_EXECUTOR_LOG_DIR.trim()]
    : []),
  ...(configuredExecutorLogFile && isAbsolute(configuredExecutorLogFile)
    ? [dirname(configuredExecutorLogFile)]
    : []),
].filter((directory, index, directories) => directories.indexOf(directory) === index)
const logRetention = new LogRetentionService({
  directories: runtimeLogDirectories,
  onResult: reportLogCleanup,
})
const appUpdates = new AppUpdateService({
  store: new ReleaseStore(join(app.getPath('userData'), 'releases')),
  dataDirectory: app.getPath('userData'),
  currentVersion: app.getVersion(),
  executable: process.execPath,
  resources: process.resourcesPath,
  componentDataDirectory:
    process.env.WEWORK_COMPONENT_DATA_DIRECTORY?.trim() || app.getPath('userData'),
  runningComponents: async () => {
    if (runtimePhase === 'initializing') await startDesktopRuntime()
    return (await runningDesktopComponents()).paths
  },
  runtimeRoot:
    process.env.WEWORK_HARNESS_RUNTIME_ROOT?.trim() || packagedHarnessRuntimePaths().cache,
  dataSchema: packageMetadata.weworkDataSchema ?? 1,
  readableDataSchemas: packageMetadata.weworkReadableDataSchemas ?? [1],
  isPackaged: packagedApplication,
  log: event => appUpdateLogger.info(event),
  shutdown: async () => {
    await prepareApplicationShutdown()
    await Promise.all([preferences?.close(), rendererStorage?.close()])
    await appUpdateLogger
      .flush()
      .catch(error =>
        console.error('[app-update] failed to flush updater log before installation', error)
      )
  },
  restart: () => {
    app.relaunch()
    app.exit(0)
  },
  onInstallFailure: (error, stopping) => {
    if (!stopping) return
    void showStartupRecovery(error).catch(recoveryError =>
      console.error('[app-update] recovery window failed', recoveryError)
    )
  },
  updateBaseUrl,
})
const systemResume = new SystemResumeBridge(powerMonitor, () => webContents.getAllWebContents())

if (keepE2EWindowInBackground) {
  app.setActivationPolicy('prohibited')
}

if (!hasSingleInstanceLock) app.quit()

function focusStartupSplashIfActive(): boolean {
  const snapshot = startupSplash?.snapshot()
  if (!startupSplashBlocksMainWindowActivation(snapshot ?? null)) return false

  const target = startupSplashWindow
  return target ? presentWindow(target) : false
}

app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
  argv.filter(value => value.startsWith('wework://')).forEach(queueScheme)
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
  if (focusStartupRecoveryIfActive()) return
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
    if (url.startsWith('wework://')) {
      queueScheme(url)
      return { action: 'deny' }
    }
    const target = new URL(url)
    if (target.origin === allowedOrigin) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('wework://')) {
      event.preventDefault()
      queueScheme(url)
      return
    }
    if (new URL(url).origin === allowedOrigin) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const isolatedSurface = isTrustedIsolatedSurfaceAttachment(
      params as Record<string, unknown>,
      dshUrl,
      isolatedSurfacePolicies
    )
    const route = embeddedBrowserRouteFromParams(params as Record<string, unknown>)
    console.log('[webview] attachment requested', {
      ownerId: contents.id,
      partition: params.partition ?? null,
      routeLabel: route?.label ?? null,
      src: params.src ?? null,
      type: isolatedSurface ? 'isolated-surface' : 'browser',
    })
    if (!route && !isolatedSurface) {
      console.warn('[webview] rejected unknown attachment', {
        ownerId: contents.id,
        partition: params.partition ?? null,
        src: params.src ?? null,
      })
      event.preventDefault()
      return
    }
    const queue = pendingEmbeddedBrowserAttachments.get(contents.id) ?? []
    queue.push(
      isolatedSurface
        ? { kind: 'isolated-surface', partition: contents.session }
        : { kind: 'browser', label: route!.label, partition: route!.routePartition }
    )
    pendingEmbeddedBrowserAttachments.set(contents.id, queue)
    if (isolatedSurface) {
      delete params.partition
      webPreferences.session = contents.session
      webPreferences.preload = isolatedSurfacePreloadPath
    } else {
      params.partition = EMBEDDED_BROWSER_PARTITION
      webPreferences.session = session.fromPartition(EMBEDDED_BROWSER_PARTITION)
      webPreferences.preload = browserAnnotationPreloadPath
    }
    webPreferences.backgroundThrottling = workbenchBackgroundThrottling(process.platform)
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
    if (pending?.kind === 'isolated-surface') {
      if (guestContents.session !== pending.partition) {
        console.warn('[isolated-surface] rejected attached webview with an unexpected session', {
          guestId: guestContents.id,
          ownerId: contents.id,
        })
        guestContents.close()
        return
      }
      console.log('[isolated-surface] isolated Chromium renderer attached', {
        guestId: guestContents.id,
        ownerId: contents.id,
      })
      secureDshContents(guestContents, dshUrl)
      return
    }
    if (
      !pending ||
      !embeddedBrowser ||
      guestContents.session !== session.fromPartition(EMBEDDED_BROWSER_PARTITION)
    ) {
      console.warn('[embedded-browser] rejected attached webview', {
        guestId: guestContents.id,
        hasBrowserManager: Boolean(embeddedBrowser),
        ownerId: contents.id,
        pendingLabel: pending?.kind === 'browser' ? pending.label : null,
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
  const releaseRedirect = process.env.WEWORK_E2E_DSH_RELEASE_REDIRECT
  delete process.env.WEWORK_E2E_DSH_RELEASE_REDIRECT
  if (
    releaseRedirect &&
    process.env.VITE_WEWORK_E2E === 'true' &&
    process.env.WEWORK_E2E_CONTROL_URL
  ) {
    installE2eDshReleaseRedirect(session.defaultSession.webRequest, releaseRedirect)
  }
  session.defaultSession.webRequest.onErrorOccurred(
    { urls: ['http://127.0.0.1/*', 'http://localhost/*'] },
    details => {
      rendererStartupLoader.requestFailed(details)
      const diagnostic = {
        at: new Date().toISOString(),
        path: new URL(details.url).pathname,
        method: details.method,
        error: details.error,
        webContentsId: details.webContentsId,
      }
      if (
        diagnostic.path === '/wework/executor/v1/rpc' &&
        typeof details.webContentsId === 'number'
      ) {
        void executorTransportDiagnosticsLog
          .record(
            details.webContentsId,
            '[Wework] Executor transport diagnostic ' + JSON.stringify(diagnostic)
          )
          .catch(error => console.warn('[Wework] Failed to write network diagnostics', error))
      }
      if (process.env.VITE_WEWORK_E2E === 'true') {
        console.error('[desktop-e2e-network-error]', diagnostic)
      }
    }
  )
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const label =
      typeof details.webContentsId === 'number'
        ? dshWindowLabels.get(details.webContentsId)
        : undefined
    callback({
      requestHeaders: dshBrowserRequestHeaders(
        details.url,
        label
          ? { ...details.requestHeaders, 'X-Wework-Window-Label': label }
          : details.requestHeaders
      ),
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
    await rendererStorage
      ?.prepareOrigin(new URL(dshUrl).origin, {
        clearAll: () => contents.session.clearData({ dataTypes: ['localStorage'] }),
        clearOrigin: origin =>
          contents.session.clearData({
            dataTypes: ['localStorage'],
            origins: [origin],
            originMatchingMode: 'origin-in-all-contexts',
          }),
      })
      .catch(error => {
        console.warn(
          '[renderer-storage] Origin cleanup failed; opening with browser state preserved',
          error
        )
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
    startupProgress.report('renderer')
    const disposeFault =
      process.env.VITE_WEWORK_E2E === 'true' &&
      process.env.WEWORK_E2E_STARTUP_NETWORK_CHANGE === '1'
        ? installStartupNetworkFault(contents.session, targetUrl.origin)
        : undefined
    try {
      await rendererStartupLoader.load({
        webContentsId: contents.id,
        url: targetUrl.toString(),
        load: () =>
          contents.loadURL(targetUrl.toString(), {
            extraHeaders: 'X-Wework-Window-Label: main',
          }),
        onRecovery: () =>
          console.warn('[startup-network-recovery] reloading interrupted entry modules'),
      })
    } finally {
      disposeFault?.()
    }
    primaryDshLoaded = true
    runtimeError = null
    rendererHealth.ready()
    logStartupStep('primary-renderer-load', 'completed')
    void presentStartupWindow('document-loaded').catch(error => {
      console.error('[startup] failed to present the loaded desktop', error)
    })
    startStartupMaintenance('plugin diagnostics', async () => {
      const plugins = await desktopRuntime!.listCoreDshPlugins()
      const pluginName = await detectCoreDshStartupPluginFailure(
        contents,
        plugins.filter(plugin => plugin.enabled && plugin.canToggle).map(plugin => plugin.name)
      )
      if (!pluginName || quitting || contents.isDestroyed()) return
      console.warn('[core-dsh] plugin failed to load', { pluginName })
      logStartupStep('core-dsh-plugin-load', 'failed', { plugin: pluginName })
    })
  } catch (error) {
    primaryDshLoaded = false
    rendererHealth.failed('renderer_load_failed')
    logStartupStep('primary-renderer-load', 'failed')
    startupTelemetry.fail('renderer_load')
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
  processExplorerWindow?.destroy()
  processExplorerWindow = null
  popoutWindowCreationPromise = null
  popoutWindowReadyPromise = null
  popoutWindowMode = 'composer'
  primaryDshLoaded = false
}

async function restartPrimaryCoreDsh(): Promise<void> {
  if (!desktopRuntime) throw new Error('Core desktop runtime is unavailable')
  disposeCoreDshViews()
  await mainWindow?.webContents.loadURL('about:blank')
  await desktopRuntime.restartCoreDsh()
  await loadPrimaryDshView()
  await restoreFixedWorkspaceWindows()
}

function scheduleCoreDshRestart(): void {
  setTimeout(() => {
    void (async () => {
      if (!desktopRuntime) throw new Error('Core desktop runtime is unavailable')
      runtimePhase = 'initializing'
      runtimeError = null
      lastStartupFailure = null
      rendererHealth.loading()
      notifyRuntimeChanged()
      await restartPrimaryCoreDsh()
      runtimePhase = lastStartupFailure ? 'failed' : 'ready'
      notifyRuntimeChanged()
    })().catch(error => {
      recordStartupFailure(error, 'core_dsh_restart')
      rendererHealth.failed('core_dsh_restart_failed')
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
    backgroundColor: desktopAppearance.current().backgroundColor,
    show: false,
    webPreferences: {
      backgroundThrottling: workbenchBackgroundThrottling(process.platform),
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
    menuCapabilities.delete(input.label)
    syncApplicationMenuCapabilities()
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

async function restoreFixedWorkspaceWindows(): Promise<void> {
  const descriptors = fixedWorkspaceWindowDescriptors(await requiredPreferences().read())
  await Promise.all(
    descriptors.map(descriptor =>
      openWorkspaceWindow(descriptor).catch(error => {
        console.error(`[workspace-window] failed to restore ${descriptor.label}`, error)
      })
    )
  )
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
    width: isSystemDrag ? 440 : POPOUT_WINDOW_SIZES.composer.width,
    height: isSystemDrag ? 60 : POPOUT_WINDOW_SIZES.composer.height,
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
      backgroundThrottling: workbenchBackgroundThrottling(process.platform),
      preload: dshPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  if (isSystemDrag) pendingSystemDragWindow = auxiliaryWindow
  secureDshContents(auxiliaryWindow.webContents, desktopRuntime.coreDshUrl())
  registerDshWindowLabel(auxiliaryWindow.webContents, kind)
  if (!isSystemDrag) {
    auxiliaryWindow.webContents.on('before-input-event', (event, input) => {
      handlePopoutWindowInput(event, input, () => auxiliaryWindow.hide())
    })
  }
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
      if (popoutWindow === auxiliaryWindow) {
        popoutWindow = null
        popoutWindowMode = 'composer'
      }
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
      resizePopoutWindow('composer', popoutWindowMode)
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

/**
 * Opens (or focuses) the standalone process explorer window. It is a plain,
 * resizable window that loads the renderer's /process-explorer route, mirroring
 * how the popout and system-drag auxiliary windows are created.
 */
async function openProcessExplorerWindow(): Promise<void> {
  if (!desktopRuntime) throw new Error('Core desktop runtime is unavailable')
  const existing = processExplorerWindow
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }
  const target = resolveDshAppRoute(desktopRuntime.coreDshUrl(), 'process-explorer')
  const window = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 520,
    minHeight: 360,
    title: 'Process Explorer',
    autoHideMenuBar: true,
    backgroundColor: desktopAppearance.current().backgroundColor,
    show: false,
    webPreferences: {
      backgroundThrottling: workbenchBackgroundThrottling(process.platform),
      preload: dshPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  processExplorerWindow = window
  window.removeMenu()
  window.setMenuBarVisibility(false)
  secureDshContents(window.webContents, desktopRuntime.coreDshUrl())
  registerDshWindowLabel(window.webContents, 'process-explorer')
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[process-explorer] renderer failed to load', { code, description, url })
  })
  window.on('closed', () => {
    if (processExplorerWindow === window) processExplorerWindow = null
  })
  try {
    await window.loadURL(target.toString(), {
      extraHeaders: 'X-Wework-Window-Label: process-explorer',
    })
    await waitForRendererSelector(window.webContents, '[data-testid="process-explorer-window"]')
    window.show()
    window.focus()
  } catch (error) {
    if (processExplorerWindow === window) processExplorerWindow = null
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}

function resizePopoutWindow(previousMode: PopoutWindowMode, mode: PopoutWindowMode): void {
  const target = popoutWindow
  if (!target || target.isDestroyed()) return

  const current = target.getBounds()
  const center = {
    x: current.x + current.width / 2,
    y: current.y + current.height / 2,
  }
  const workArea = screen.getDisplayNearestPoint(center).workArea
  target.setBounds(popoutWindowBounds(current, workArea, previousMode, mode))
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
  if (keepE2EWindowInBackground) {
    e2eForegroundActivationAllowed = true
    app.setActivationPolicy('accessory')
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const bounds = target.getBounds()
  target.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - bounds.width) / 2),
    Math.round(display.workArea.y + (display.workArea.height - bounds.height) / 2)
  )
  presentWindow(target)
}

async function togglePopoutWindow(): Promise<void> {
  if (popoutWindow && !popoutWindow.isDestroyed() && popoutWindow.isVisible()) {
    popoutWindow.hide()
    return
  }
  await showPopoutWindow()
}

async function updateDesktopPreferences(
  patch: Record<string, unknown>,
  expectedTelemetryConsentRevision?: number
): Promise<Record<string, unknown>> {
  if (!desktopPreferences) throw new Error('Desktop preferences are unavailable')
  if (Object.hasOwn(patch, 'appearanceThemeSnapshot') && patch.appearanceThemeSnapshot !== null) {
    const snapshot = normalizeAppearanceThemeSnapshot(patch.appearanceThemeSnapshot)
    if (!snapshot) throw new Error('appearanceThemeSnapshot is invalid')
    patch = { ...patch, appearanceThemeSnapshot: snapshot }
  }
  const updated = await desktopPreferences.update(patch, expectedTelemetryConsentRevision)
  if (Object.hasOwn(patch, 'appearanceMode') || Object.hasOwn(patch, 'appearanceThemeSnapshot')) {
    desktopAppearance.update(updated)
  }
  return updated
}

async function createWindow(
  startupTheme: StartupSplashTheme,
  savedWindowState: unknown
): Promise<void> {
  const startupDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const startupLayout = startupWindowLayout(
    startupDisplay.workArea,
    savedWindowState,
    screen.getAllDisplays().map(display => display.workArea)
  )
  logStartupStep('windows-create', 'started', { theme: startupTheme, layout: startupLayout })
  const developmentTitle = process.env.WEWORK_PLUGIN_DEVELOPMENT_TITLE?.trim()
  const windowTitle =
    pluginDevelopmentInstance && developmentTitle
      ? `Wework Plugin Development — ${developmentTitle}`
      : (developmentDockIdentity?.displayName ?? 'Wework')
  mainWindow = new BrowserWindow({
    ...desktopWindowFrameOptions(),
    ...desktopE2EWindowOptions(process.env, process.platform),
    ...startupLayout.bounds,
    title: windowTitle,
    backgroundColor: startupTheme === 'dark' ? '#181818' : '#fafafa',
    show: false,
    webPreferences: {
      backgroundThrottling: workbenchBackgroundThrottling(process.platform),
      preload: dshPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  })
  installE2ERendererCpuProfiling(mainWindow.webContents)
  startupSplashWindow = new BrowserWindow({
    ...desktopWindowFrameOptions(),
    ...startupLayout.bounds,
    title: windowTitle,
    backgroundColor: startupTheme === 'dark' ? '#05070d' : '#fafafa',
    show: false,
    webPreferences: {
      backgroundThrottling: false,
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
      show: async () => {
        if (keepE2EWindowInBackground) return
        const target = startupSplashWindow
        if (!target) throw new Error('Startup splash window is unavailable')
        target.show()
        if (startupLayout.maximized) {
          try {
            target.maximize()
          } catch (error) {
            console.warn('[startup-splash] failed to maximize startup window', error)
          }
        }
      },
      setOpacity: opacity => startupSplashWindow?.setOpacity(opacity),
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
        send: (channel, payload) => {
          startupSplashWindow?.webContents.send(channel, payload)
        },
      },
    },
    theme: startupTheme,
    // The splash is the only visible window until the workbench reports
    // readiness, so a user closing it through the native close button means
    // quitting the application instead of dismissing the window.
    onCloseRequest: () => {
      if (quitting) return
      requestApplicationShutdown(() => app.quit())
    },
  })
  startupSplashWindow.on('closed', () => {
    startupSplashWindow = null
  })
  startupProgress.report('launch')
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
    query: {
      theme: startupTheme,
      ...(startupTiming ? { slowAfterMs: String(startupTiming.slowAfterMs) } : {}),
    },
  })
  logStartupStep('startup-splash-load', 'completed')
  logStartupStep('startup-splash-show', 'started')
  await startupSplash.show()
  if (startupTiming) {
    startupSplashObserver = observeStartupSplash(startupSplashWindow, startupSplashInspection)
  }
  logStartupStep('startup-splash-show', 'completed')
  logStartupStep('main-shell-load', 'started')
  startupProgress.report('shell')
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

async function holdStartupSplashForDesktopE2e(): Promise<void> {
  const holdMs = resolveStartupSplashHoldMs(process.env)
  if (holdMs <= 0) return
  logStartupStep('startup-splash-hold', 'started', { holdMs })
  await new Promise<void>(resolve => {
    setTimeout(resolve, holdMs)
  })
  logStartupStep('startup-splash-hold', 'completed')
}

async function startupSplashInspection() {
  return {
    ...(await inspectStartupSplash(startupSplashWindow)),
    failure: lastStartupFailure,
    logDirectory: app.getPath('logs'),
  }
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
}

async function closeMainWindowToTray(): Promise<void> {
  const decision = await windowClosePolicy?.confirmCloseToTray()
  if (decision) await applyWindowCloseDecision(decision)
}

async function cancelMainWindowClose(): Promise<void> {
  const decision = await windowClosePolicy?.cancelCloseToTray()
  if (decision) await applyWindowCloseDecision(decision)
}

const presentStartupWindow = createStartupReadyHandler(async (source: string) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (quitting) return
    throw new Error('The main window is unavailable during startup')
  }
  logStartupStep('startup-window-presentation', 'started', { source })
  await holdStartupSplashForDesktopE2e()
  // A quit request during startup owns the exit: never present the
  // workbench while shutdown is already tearing the app down.
  if (quitting) return
  if (lastStartupFailure) throw new Error(lastStartupFailure.message)
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('The main window closed before startup handoff')
  }
  const target = mainWindow
  const splash = startupSplash
  const splashWindow = startupSplashWindow
  let handoffActive = true
  const canPresent = () => !quitting && !lastStartupFailure && !target.isDestroyed()
  const shouldContinue = () => handoffActive && canPresent()
  try {
    if (!splash || !splashWindow) throw new Error('Startup splash is unavailable for handoff')
    await splash.handoff({
      update: startupProgress.complete(),
      capturePath: process.env.WEWORK_E2E_STARTUP_SPLASH_CAPTURE?.trim(),
      shouldContinue,
      prepareMainWindow: async () => {
        const bounds = await prepareStartupMainWindow(
          target,
          splashWindow,
          !keepE2EWindowInBackground,
          {
            main: screen.getDisplayMatching(target.getBounds()).id,
            splash: screen.getDisplayMatching(splashWindow.getBounds()).id,
          },
          event => {
            const geometry = event.splash ?? event.main
            const display = geometry ? screen.getDisplayMatching(geometry.bounds) : null
            logStartupStep('startup-window-handoff', event.error ? 'failed' : 'completed', {
              ...event,
              display: display
                ? {
                    id: display.id,
                    scaleFactor: display.scaleFactor,
                    bounds: display.bounds,
                    workArea: display.workArea,
                  }
                : null,
            })
          },
          shouldContinue
        )
        logStartupStep('main-window-show', 'completed')
        return bounds
      },
    })
    if (!shouldContinue()) {
      if (quitting) return
      throw new Error('Startup window handoff was interrupted')
    }
  } catch (error) {
    if (quitting) return
    if (!canPresent()) throw error
    handoffActive = false
    console.warn('[startup-window-handoff] presenting the ready window without animation', error)
    target.setOpacity(1)
    if (!keepE2EWindowInBackground) target.show()
    await splash?.close().catch(closeError => {
      console.warn('[startup-window-handoff] failed to close splash', closeError)
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
    })
  }
  if (!canPresent()) return
  logStartupStep('startup-splash-close', 'completed')
  mainWindowState?.start(target)
  if (!keepE2EWindowInBackground) {
    target.focus()
    target.webContents.focus()
  }
})

const rendererStartupReady = createStartupReadyHandler(async (source: string) => {
  logStartupStep('renderer-startup-ready', 'completed', { source })
  await presentStartupWindow(source)
  startupTelemetrySuccess.markRendererReady()
  scheduleComputerUseStartup()
})

async function reactivateMainWindow(): Promise<void> {
  if (focusStartupRecoveryIfActive()) return
  if (focusStartupSplashIfActive()) return
  if (quitting) return
  const target = mainWindow
  if (!target || target.isDestroyed()) return
  if (keepE2EWindowInBackground) {
    e2eForegroundActivationAllowed = true
    app.setActivationPolicy('regular')
    app.show()
    dockVisible = true
  } else {
    await setDockVisible(true)
  }
  presentWindow(target)
  await loadPrimaryDshView()
}

function dispatchTrayAction(action: TrayAction): void {
  if (action.type === 'quit-app') {
    requestApplicationShutdown(() => app.quit())
    return
  }
  void activateTrayAction(action, reactivateMainWindow, readyAction => {
    if (!quitting) desktopHostEvents.publish('tray.action', readyAction)
  }).catch(error => {
    console.error('[window] failed to handle tray action', error)
  })
}

/**
 * Resolves the workbench window a menu action should target: the focused
 * workspace/main window, falling back to the most recently focused one.
 */
function applicationMenuWindow(label?: string): BrowserWindow | null {
  if (label) return label === 'main' ? mainWindow : (workspaceWindows.get(label) ?? null)
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && (focused === mainWindow || [...workspaceWindows.values()].includes(focused))) {
    return focused
  }
  return lastMenuWindow && !lastMenuWindow.isDestroyed() ? lastMenuWindow : mainWindow
}

function menuLabelForWindow(window: BrowserWindow): string {
  return dshWindowLabels.get(window.webContents.id) ?? 'main'
}

/**
 * In-app menu destinations need a visible window. Opening the About page or
 * feedback dialog in a minimized/hidden window would otherwise appear to do
 * nothing, unlike the external link and native panel these actions replace.
 */
function revealApplicationMenuWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** Applies the capabilities of the window that currently owns the menu. */
function syncApplicationMenuCapabilities(): void {
  const window = applicationMenuWindow()
  if (!window) {
    applicationMenu?.setCapabilities(EMPTY_APPLICATION_MENU_CAPABILITIES)
    return
  }
  applicationMenu?.setCapabilities(
    menuCapabilities.get(menuLabelForWindow(window)) ?? EMPTY_APPLICATION_MENU_CAPABILITIES
  )
}

function installApplicationMenu(): void {
  applicationMenu = new ApplicationMenu({
    platform: process.platform,
    appName: app.getName(),
    buildMenu: template => Menu.buildFromTemplate(template),
    setApplicationMenu: menu => {
      Menu.setApplicationMenu(menu)
      // Windows and Linux windows are frameless, and Electron never creates a
      // native menu bar in a frameless window (RootView::SetMenu returns early
      // when the window has no frame), so there is nothing to hide. The
      // workbench exposes its own application-menu button instead, while the
      // menu accelerators stay registered and active.
    },
    targetWindow: applicationMenuWindow,
    closeWindow: () => {
      const focused = BrowserWindow.getFocusedWindow()
      return focused && !focused.isDestroyed() ? focused : applicationMenuWindow()
    },
    dispatch: (action: ApplicationMenuAction, window: BrowserWindow) => {
      if (
        action === APPLICATION_MENU_ACTIONS.closeTab &&
        BrowserWindow.getFocusedWindow() === processExplorerWindow
      ) {
        processExplorerWindow?.close()
        return
      }
      if (
        action === APPLICATION_MENU_ACTIONS.openAbout ||
        action === APPLICATION_MENU_ACTIONS.openFeedback
      ) {
        revealApplicationMenuWindow(window)
      }
      desktopHostEvents.publish('application-menu.action', {
        action,
        windowLabel: menuLabelForWindow(window),
      })
    },
    openDevTools: window => openWindowDevTools(window),
    openLogDirectory: openApplicationLogDirectory,
    openProcessExplorer: openProcessExplorerWindow,
    showMain: reactivateMainWindow,
    quit: () => requestApplicationShutdown(() => app.quit()),
    openExternal: url => shell.openExternal(url),
    reportError: error => console.error('[application-menu] action failed', error),
  })
  // Bootstrap with the OS locale; the renderer reports the Wework language
  // preference through applicationMenu.setLanguage once it mounts, so the menu
  // follows the in-app language instead of the system locale.
  applicationMenu.setLanguage(app.getLocale())
  app.on('browser-window-created', (_event, window) => {
    window.on('focus', () => {
      if (window === mainWindow || [...workspaceWindows.values()].includes(window)) {
        lastMenuWindow = window
        syncApplicationMenuCapabilities()
      }
    })
  })
  syncApplicationMenuCapabilities()
}

function openWindowDevTools(window: BrowserWindow): void {
  const contents = window.webContents
  if (contents.isDestroyed()) return
  contents.openDevTools({ mode: 'detach', activate: true })
}

function createTrayManager(): ElectronTrayManager<Electron.Menu | null, Tray> {
  const resourcesRoot = packagedApplication ? process.resourcesPath : developmentResourcesRoot
  const iconPath = join(resourcesRoot, 'icons', trayIconFilename())
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

function recordStartupFailure(error: unknown, source: string): void {
  lastStartupFailure = startupFailureSnapshot(error, {
    source,
    stage: startupProgress.currentUpdate()?.stage.id,
  })
  runtimeError = lastStartupFailure.message
  runtimePhase = 'failed'
  console.error('[startup] failure', lastStartupFailure)
  notifyRuntimeChanged()
}

async function startupDiagnosticsText(): Promise<string> {
  const bootstrapLogPath = mainProcessLog.startupBootstrapPath
  await Promise.allSettled([
    mainProcessLog.flush(),
    startupRendererLog.flush(),
    runtimeDiagnosticsLog.flush(),
    localWorkspaceCatalogLog.flush(),
  ])
  return buildStartupDiagnostics({
    appName: app.getName(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    logDirectories: runtimeLogDirectories,
    extraLogPaths: bootstrapLogPath ? [bootstrapLogPath] : [],
    progress: {
      current: startupProgress.currentUpdate(),
      history: startupProgress.history(),
    },
    failure: lastStartupFailure,
    runtimeError,
    runtimeState: desktopRuntime?.diagnostics() ?? null,
  })
}

function installIpc(): void {
  if (process.env.VITE_WEWORK_E2E === 'true' && process.env.WEWORK_E2E_CONTROL_URL) {
    const downloadsPath = process.env.WEWORK_E2E_DOWNLOADS_DIR?.trim()
    if (downloadsPath) app.setPath('downloads', resolve(downloadsPath))
    ipcMain.handle('e2e:runtime-request', (event, input) => {
      if (!dshWindowLabels.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Runtime verification requires a Wework main frame')
      }
      return requestE2ERuntime(process.env, input, url =>
        dshBrowserAuthenticationCookies(session.defaultSession, url)
      )
    })
  }
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
  ipcMain.handle('startup-recovery:disable-plugin', (event, name: unknown) => {
    assertStartupRecoverySender(event.sender.id, startupSplashWindow?.webContents.id ?? null)
    if (typeof name !== 'string' || !name.trim()) throw new Error('Plugin name is required')
    return requiredStartupRecovery().disablePlugin(name)
  })
  ipcMain.handle('startup-diagnostics:copy', async event => {
    assertStartupRecoverySender(event.sender.id, startupSplashWindow?.webContents.id ?? null)
    const text = await startupDiagnosticsText()
    clipboard.writeText(text)
    logStartupStep('startup-diagnostics-copy', 'completed', { characters: text.length })
    return { ok: true, characters: text.length }
  })
  ipcMain.handle('startup-diagnostics:open-logs', async event => {
    assertStartupRecoverySender(event.sender.id, startupSplashWindow?.webContents.id ?? null)
    logStartupStep('startup-diagnostics-open-logs', 'started')
    try {
      await openApplicationLogDirectory()
      logStartupStep('startup-diagnostics-open-logs', 'completed')
      return { ok: true }
    } catch (error) {
      logStartupStep('startup-diagnostics-open-logs', 'failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })
  ipcMain.handle('cloud-credentials:prepare-authorization', async (_event, apiBaseUrl: unknown) => {
    try {
      return {
        ok: true,
        value: await requiredCloudCredentials().prepareAuthorization(
          requiredText(apiBaseUrl, 'apiBaseUrl')
        ),
      }
    } catch (error) {
      return cloudCredentialFailure(error)
    }
  })
  ipcMain.handle('cloud-credentials:claim-authorization', async (_event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new CloudCredentialError('request_failed', 'Authorization input is invalid')
      }
      const value = input as Record<string, unknown>
      return {
        ok: true,
        value: await requiredCloudCredentials().claimAuthorization({
          authorizationId: requiredText(value.authorizationId, 'authorizationId'),
          sessionId: requiredText(value.sessionId, 'sessionId'),
          pollToken: requiredText(value.pollToken, 'pollToken'),
        }),
      }
    } catch (error) {
      return cloudCredentialFailure(error)
    }
  })
  ipcMain.handle(
    'cloud-credentials:commit-authorization',
    async (_event, authorizationId: unknown, ownerUserId: unknown) => {
      try {
        if (typeof ownerUserId !== 'number') throw new Error('Cloud credential owner is invalid')
        return {
          ok: true,
          value: await requiredCloudCredentials().commitAuthorization(
            requiredText(authorizationId, 'authorizationId'),
            ownerUserId
          ),
        }
      } catch (error) {
        return cloudCredentialFailure(error)
      }
    }
  )
  ipcMain.handle(
    'cloud-credentials:discard-authorization',
    async (_event, authorizationId: unknown) => {
      try {
        return {
          ok: true,
          value: await requiredCloudCredentials().discardAuthorization(
            requiredText(authorizationId, 'authorizationId')
          ),
        }
      } catch (error) {
        return cloudCredentialFailure(error)
      }
    }
  )
  ipcMain.handle(
    'cloud-credentials:refresh-access-token',
    async (_event, apiBaseUrl: unknown, expectedUserId: unknown) => {
      try {
        if (typeof expectedUserId !== 'number') throw new Error('Cloud credential owner is invalid')
        return {
          ok: true,
          value: await requiredCloudCredentials().refreshAccessToken(
            requiredText(apiBaseUrl, 'apiBaseUrl'),
            expectedUserId
          ),
        }
      } catch (error) {
        return cloudCredentialFailure(error)
      }
    }
  )
  ipcMain.handle(
    'plugin-auth:configure',
    async (_event, apiBaseUrl: unknown, accountToken: unknown) => {
      try {
        const value = await pluginNativeAuthorization.configure(
          requiredText(apiBaseUrl, 'apiBaseUrl'),
          requiredText(accountToken, 'accountToken')
        )
        return { ok: true, value }
      } catch (error) {
        return cloudCredentialFailure(error)
      }
    }
  )
  ipcMain.handle('cloud-credentials:clear', async () => {
    const clear = requiredCloudCredentials().clear()
    await Promise.all([clear, pluginNativeAuthorization.clear()])
  })
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
    const [runtime, pythonStatus] = await Promise.all([
      electronNodeRuntime(),
      managedPythonRuntime().then(python => python.status()),
    ])
    const configuredPath = await configuredNodePath()
    return [
      {
        ...runtime.status,
        configuredPath,
        restartRequired:
          configuredPath !== (runtime.status.source === 'configured' ? runtime.status.path : null),
      },
      pythonStatus,
    ]
  })
  ipcMain.handle('runtime:ensure-python', async () => {
    const pythonRuntime = await managedPythonRuntime()
    if (!pythonRuntimeEnabled) {
      return pythonRuntime.status()
    }
    return pythonRuntime.ensure({ manual: true })
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
  ipcMain.handle('runtime:resolve-proxy', async (_event, targetUrl: string) =>
    resolveSystemProxy(session.defaultSession, targetUrl)
  )
}

async function shutdown(): Promise<void> {
  await traceShutdownStep('main-window-state', () => mainWindowState?.stop()).catch(error => {
    console.error('[window-state] Failed to save main window geometry during shutdown', error)
  })
  pluginDevelopmentChildRuntime?.stopWatcher()
  await traceShutdownStep('child-runtime-stopping', () =>
    pluginDevelopmentChildRuntime?.writeState('stopping')
  )
  await traceShutdownStep('performance-recording', async () => {
    await performanceRecorder?.stop().catch(error => {
      console.error('[performance] Failed to flush performance recording during shutdown', error)
    })
    performanceRecorder = null
  })
  await traceShutdownStep('log-retention', () => logRetention.stop())
  await traceShutdownStep('mcp-apps', async () => {
    try {
      const results = await settleMcpAppCleanup(mcpAppCleanups)
      for (const result of results) {
        if (result.status === 'rejected')
          console.error('[Wework] MCP App shutdown cleanup failed', result.reason)
      }
    } catch (error) {
      console.error('[Wework] MCP App shutdown cleanup timed out', { name: (error as Error).name })
    }
    mcpAppCleanups.clear()
    mcpAppRuntime?.dispose()
    mcpAppRuntime = null
    cloudModelRuntime?.dispose()
    cloudModelRuntime = null
  })
  systemResume.stop()
  systemSleep.stop()
  trayNativeStatus?.stop()
  trayNativeStatus = null
  // Keep the tray alive until process exit. Explicit destruction removes the
  // macOS status item's saved position, undoing menu bar manager placement.
  for (const workspaceWindow of workspaceWindows.values()) {
    if (!workspaceWindow.isDestroyed()) workspaceWindow.destroy()
  }
  workspaceWindows.clear()
  disposeSystemDragWindow()
  // The startup splash refuses native close requests until the workbench is
  // ready. When the app quits within that window, an open splash cancels
  // app.quit() and strands the app on the splash, so close it through the
  // controlled-close path as part of every shutdown.
  await traceShutdownStep('startup-splash', () => startupSplash?.close())
  popoutWindow?.destroy()
  popoutWindow = null
  popoutWindowCreationPromise = null
  popoutWindowReadyPromise = null
  popoutWindowMode = 'composer'
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
  const stoppedServices = await Promise.allSettled([
    traceShutdownStep('browser-bridge', () => browserBridge?.stop()),
    traceShutdownStep('control-bridge', () => controlBridge?.stop()),
    traceShutdownStep('computer-use', () => computerUseService?.stop()),
    traceShutdownStep('plugin-development', () => development?.stop()),
    traceShutdownStep('desktop-runtime', () => desktopRuntime?.stop()),
  ])
  await localWorkspaceCatalogLog.flush().catch(() => {
    console.warn('[Wework] Failed to flush local workspace catalog diagnostics')
  })
  const stopFailures = stoppedServices.filter(result => result.status === 'rejected')
  if (stopFailures.length)
    throw new AggregateError(
      stopFailures.map(result => result.reason),
      'Desktop services did not stop cleanly'
    )
  await traceShutdownStep('child-runtime-stopped', () =>
    pluginDevelopmentChildRuntime?.writeState('stopped')
  )
}

function requestApplicationShutdown(exit: () => void): void {
  void prepareApplicationShutdown().finally(exit)
}

function prepareApplicationShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  quitting = true
  rendererStartupReady.cancel()
  presentStartupWindow.cancel()
  shutdownPromise = traceShutdownStep('application', shutdown)
  return shutdownPromise
}

function smartAppRuntimeHost(): SmartAppRuntimeHost | null {
  const runtime = desktopRuntime
  if (!runtime) return null
  return {
    open: launch => runtime.openWorkbenchRuntime(launch),
    close: tabId => runtime.closeWorkbenchRuntime(tabId),
    runningTabIds: () => new Set(runtime.diagnostics().workbenchRuntimes.map(item => item.tabId)),
  }
}

function downloadsDirectory(): string {
  return resolveDownloadsDirectory(
    name => app.getPath(name),
    (error, fallbackPath) => {
      console.warn(
        `[downloads] system Downloads folder is unavailable; using ${fallbackPath}`,
        error
      )
    }
  )
}

async function configureDesktopRuntime(): Promise<void> {
  if (desktopRuntime) return
  logStartupStep('runtime-configure', 'started')
  logStartupStep('workbench-mode-initialize', 'started')
  await initializeWorkbenchModePreference(requiredPreferences(), {
    environment: process.env,
    homeDirectory: app.getPath('home'),
  })
  logStartupStep('workbench-mode-initialize', 'completed')
  logStartupStep('desktop-environment', 'started')
  const environment = await desktopEnvironment()
  startupRuntimeEnvironment = environment
  logStartupStep('desktop-environment', 'completed')
  if (!pluginDevelopmentInstance && !pluginDevelopment) {
    pluginDevelopment = new PluginDevelopmentManager({
      ...currentElectronLaunch(),
      environment,
      userDataDirectory: app.getPath('userData'),
      confirmInstall: request =>
        confirmCoreDshPluginInstall(request, mainWindow, nativeDialogLanguage),
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
  logStartupStep('runtime-preferences-read', 'started')
  const { preferences: codexSubscriptionPreferences, readable: codexPreferenceReadable } =
    await preferences.readSnapshot()
  logStartupStep('runtime-preferences-read', 'completed')
  // The Electron PreferencesStore returns raw JSON without normalization, so an
  // absent field (e.g. a fresh install or a user who never toggled it) must fall
  // back to the default (enabled) rather than being treated as disabled.
  const hasCodexSubscriptionField = Object.prototype.hasOwnProperty.call(
    codexSubscriptionPreferences,
    'localCodexSubscriptionEnabled'
  )
  const codexSubscriptionEnabled = hasCodexSubscriptionField
    ? codexSubscriptionPreferences.localCodexSubscriptionEnabled === true
    : true
  environment.WEWORK_CODEX_SUBSCRIPTION_ENABLED = codexPreferenceReadable
    ? codexSubscriptionEnabled
      ? 'true'
      : 'false'
    : 'unavailable'
  const feedback = new FeedbackBundleManager({
    appVersion: () => app.getVersion(),
    cacheDirectory: join(app.getPath('userData'), 'cache'),
    downloadsDirectory,
    logDirectories: runtimeLogDirectories,
  })
  const secureStorage = new SecureValueStore(app.getPath('userData'))
  const modelConfiguration = new ModelConfigurationStore(
    join(protectedCredentialDirectory(app.getPath('userData')), 'model-connections'),
    secureStorage,
    join(app.getPath('userData'), 'model-connections')
  )
  cloudModelRuntime = new CloudModelRuntime(
    () => readCloudConnection(rendererStorage!),
    async (apiBaseUrl, expectedUserId) =>
      (await requiredCloudCredentials().refreshAccessToken(apiBaseUrl, expectedUserId)).accessToken
  )
  const modelRuntimeRequest = new ModelRuntimeRequest(
    modelConfiguration,
    {
      request: (method, params) => {
        if (!desktopRuntime) throw new Error('Desktop runtime is unavailable')
        return desktopRuntime.requestExecutor(method, params)
      },
      dispose: () => {},
    },
    input => cloudModelRuntime!.transport(input),
    async targetUrl => {
      const raw = (await rendererStorage!.read())[LOCAL_PROXY_SETTINGS_STORAGE_KEY]
      const config = storedLocalProxyConfig(raw ? JSON.parse(raw) : {})
      if (config.mode === 'custom') return normalizeLocalProxyUrl(config.proxyUrl) || null
      if (config.mode === 'direct') return null
      return resolveSystemProxy(session.defaultSession, targetUrl)
    }
  )
  embeddedBrowser = new EmbeddedBrowserManager(
    app.getPath('userData'),
    event => {
      desktopHostEvents.publish('browser.event', { ...event })
    },
    openSchemeInMainWindow
  )
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
    environment.WEGENT_EXECUTOR_HOME?.trim() || join(app.getPath('home'), '.wework'),
    async () => (await preferences?.read())?.browserFullControl === true
  )
  startupProgress.report('services')
  logStartupStep('embedded-browser-bridge', 'started')
  try {
    environment.WEWORK_EMBEDDED_BROWSER_BRIDGE_RUNTIME_FILE = await embeddedBrowserBridge.start()
    Object.assign(environment, embeddedBrowserBridge.environment())
    logStartupStep('embedded-browser-bridge', 'completed')
  } catch (error) {
    console.warn('[browser] Browser bridge is unavailable', error)
    logStartupStep('embedded-browser-bridge', 'failed')
  }
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
    smartApps: () => smartApps,
    ensurePython: pythonRuntimeEnabled
      ? async () => (await managedPythonRuntime()).ensure()
      : undefined,
    pythonDownloads: pythonRuntimeEnabled ? pythonRuntimeDownloads : undefined,
    pythonStatus: pythonRuntimeEnabled
      ? async () => (await managedPythonRuntime()).status()
      : undefined,
    resolvePython: pythonRuntimeEnabled
      ? async (pluginRoot, allowSystemFallback, prepare) =>
          (await managedPythonRuntime()).resolvePluginPython(
            pluginRoot,
            allowSystemFallback,
            prepare
          )
      : undefined,
    prewarmPython: pythonRuntimeEnabled
      ? async () => (await managedPythonRuntime()).prewarm()
      : undefined,
    ...(process.env.VITE_WEWORK_E2E === 'true' && process.env.WEWORK_E2E_CONTROL_URL
      ? { devtools: new VerificationDevtools(() => webContents.getAllWebContents()) }
      : {}),
  })
  logStartupStep('desktop-control-bridge', 'started')
  if (pythonRuntimeEnabled) {
    // Executors inherit the Python capability only after its listener is ready.
    try {
      await desktopControlBridge.start()
      Object.assign(environment, desktopControlBridge.environment())
      logStartupStep('desktop-control-bridge', 'completed')
    } catch (error) {
      console.warn('[desktop-control] Desktop control and plugin Python are unavailable', error)
      logStartupStep('desktop-control-bridge', 'failed')
    }
  } else {
    startStartupMaintenance('desktop control bridge', async () => {
      await desktopControlBridge!.start()
      logStartupStep('desktop-control-bridge', 'completed')
    })
  }
  computerUse = new ComputerUseService(
    environment.WEGENT_EXECUTOR_HOME?.trim() || join(app.getPath('home'), '.wework')
  )
  const runtimeRoot = environment.WEWORK_HARNESS_RUNTIME_ROOT?.trim()
  if (runtimeRoot) {
    smartApps = new SmartAppManager({
      dataDirectory: app.getPath('userData'),
      documentsDirectory: () => app.getPath('documents'),
      downloadsDirectory,
      logDirectory: app.getPath('logs'),
      runtimeRoot,
      environment,
      runtimeHost: smartAppRuntimeHost,
    })
  }
  const processExplorerService = createWeworkProcessExplorerService({
    windowLabel: contentsId => dshWindowLabels.get(contentsId) ?? null,
    embeddedBrowserLabel: contentsId => embeddedBrowser?.labelForContentsId(contentsId) ?? null,
    runtime: async () => {
      const diagnostics = desktopRuntime?.diagnostics()
      const pluginSessions = pluginDevelopment ? await pluginDevelopment.list() : []
      return {
        coreDshPid: diagnostics?.coreDshPid ?? null,
        executorPid: diagnostics?.executorPid ?? null,
        workbenchRuntimes: diagnostics?.workbenchRuntimes ?? [],
        pluginDevelopmentPids: pluginSessions.flatMap(session =>
          session.coreDshPid ? [session.coreDshPid] : []
        ),
      }
    },
  })
  await performanceRecorder?.stop()
  performanceRecorder = new PerformanceRecorder({
    logPath: join(app.getPath('logs'), 'performance.log'),
    appVersion: app.getVersion(),
    processSnapshot: () => processExplorerService.snapshot(),
  })
  await desktopPreferences?.restorePerformanceRecording().catch(error => {
    console.error(
      '[performance] Could not resume performance recording; recording is disabled',
      error
    )
  })
  desktopRuntime = new DesktopRuntime({
    applicationId,
    confirmPluginInstall: request =>
      confirmCoreDshPluginInstall(request, mainWindow, nativeDialogLanguage),
    modelConfiguration,
    environment,
    dataDirectory: app.getPath('userData'),
    logDirectory: app.getPath('logs'),
    onStartupStep: logStartupStep,
    readWorkbenchMode: async () =>
      normalizeWorkbenchMode((await requiredPreferences().read()).workbenchMode),
    createWorkbenchHostPipe: tabId => {
      const pipe = new HostPipeServer(createWorkbenchCapabilityRouter(embeddedBrowser, tabId))
      return { hostPipe: pipe, principal: WEWORK_WORKBENCH_PRINCIPAL }
    },
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
          executorHome:
            environment.WEGENT_EXECUTOR_HOME?.trim() || join(app.getPath('home'), '.wework'),
          processExplorer: processExplorerService,
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
          applicationMenu: () => applicationMenu,
          updateApplicationMenuCapabilities: (label, capabilities) => {
            menuCapabilities.set(label, capabilities)
            const window = applicationMenuWindow()
            if (window && menuLabelForWindow(window) === label) syncApplicationMenuCapabilities()
          },
          updateApplicationMenuLanguage: language => {
            nativeDialogLanguage = language
            applicationMenu?.setLanguage(language)
          },
          quitApplication: () => requestApplicationShutdown(() => app.quit()),
          relaunchApplication: () => {
            app.relaunch()
            requestApplicationShutdown(() => app.quit())
          },
          openRuntimeTask: taskAddressId =>
            dispatchTrayAction({
              type: 'open-task',
              source: 'notification',
              taskId: taskAddressId,
            }),
          registerMcpAppCleanup: cleanup => {
            mcpAppCleanups.add(cleanup)
          },
          requestMcpApp: payload => {
            mcpAppRuntime ??= new McpAppRuntime(
              request => {
                if (!desktopRuntime) throw new Error('Desktop runtime is unavailable')
                return desktopRuntime.requestExecutor('runtime.mcp_apps.request', request)
              },
              async (apiBaseUrl, expectedUserId) => {
                const credential = await requiredCloudCredentials().refreshAccessToken(
                  apiBaseUrl,
                  expectedUserId
                )
                return credential.accessToken
              },
              () => readCloudConnection(rendererStorage!)
            )
            return mcpAppRuntime.request(payload)
          },
          executorPid: () => desktopRuntime?.diagnostics().executorPid ?? null,
          modelConfiguration,
          requestModelRuntime: input => modelRuntimeRequest.request(input),
          syncLocalModels: () => desktopRuntime!.syncLocalModels(),
          secureStorage,
          takePendingWorkspaceOpenRequests,
          pendingSchemes,
          openScheme: openSchemeInMainWindow,
          updatePreferences: updateDesktopPreferences,
          weworkSyncRequest: async request => {
            const apiBaseUrl = normalizeWeworkSyncApiBaseUrl(request.apiBaseUrl)
            const expectedUserId = requireCloudCredentialOwner(
              await readCloudConnection(rendererStorage!),
              apiBaseUrl
            )
            const credential = await requiredCloudCredentials().refreshAccessToken(
              apiBaseUrl,
              expectedUserId
            )
            return requestWeworkSync(request, `${credential.tokenType} ${credential.accessToken}`)
          },
        },
        {
          disconnectMcpAppSession: sessionId => mcpAppRuntime?.dispose(sessionId),
          captureTarget: windowLabel =>
            windowLabel === 'main'
              ? (mainWindow?.webContents ?? null)
              : windowLabel === 'popout-window'
                ? (popoutWindow?.webContents ?? null)
                : windowLabel === 'system-drag-panel'
                  ? (systemDragWindow?.webContents ?? null)
                  : windowLabel === 'process-explorer'
                    ? (processExplorerWindow?.webContents ?? null)
                    : (workspaceWindows.get(windowLabel)?.webContents ?? null),
          cancelCloseToTray: cancelMainWindowClose,
          closeToTray: closeMainWindowToTray,
          focusMainWindow: reactivateMainWindow,
          focusWindow: windowLabel => {
            const target =
              windowLabel === 'main'
                ? mainWindow
                : windowLabel === 'popout-window'
                  ? popoutWindow
                  : (workspaceWindows.get(windowLabel) ?? null)
            if (target) presentWindow(target)
          },
          hideMainWindow: hideMainWindowToBackground,
          openProcessExplorer: () => openProcessExplorerWindow(),
          setProcessExplorerAlwaysOnTop: alwaysOnTop => {
            const target = processExplorerWindow
            if (!target || target.isDestroyed()) return { alwaysOnTop: false }
            target.setAlwaysOnTop(alwaysOnTop)
            return { alwaysOnTop: target.isAlwaysOnTop() }
          },
          processExplorerWindowSnapshot: () =>
            captureProcessExplorerWindowSnapshot(processExplorerWindow, process.pid),
          setProcessExplorerWindowSize: (width, height) => {
            const target = processExplorerWindow
            if (!target || target.isDestroyed()) return
            target.setSize(Math.max(520, Math.round(width)), Math.max(360, Math.round(height)))
          },
          closeProcessExplorerWindow: () => {
            const target = processExplorerWindow
            if (target && !target.isDestroyed()) target.close()
          },
          dockVisible: () => dockVisible,
          rendererStartupReady,
          rendererStartupFailed: failure => {
            if (startupSplash?.snapshot().state === 'closed') {
              console.error('[renderer] failure after startup', failure)
              return
            }
            recordStartupFailure(failure, failure.source)
            logStartupStep('renderer-startup', 'failed')
            startupTelemetry.fail('renderer_initialize')
            return startupSplash?.showError()
          },
          startupSplashSnapshot: () => startupSplash?.snapshot() ?? null,
          startupSplashInspect: () => startupSplashObserver?.inspect() ?? startupSplashInspection(),
          startupSplashClick: testId => clickStartupSplash(startupSplashWindow, testId),
          startupSplashSize: (width, height) => {
            const target = startupSplashWindow
            if (!target || target.isDestroyed()) {
              throw new Error('Startup splash is unavailable for resizing')
            }
            return setE2EWindowSize(target, width, height)
          },
          startupLogPath: path => app.setPath('logs', path ?? applicationLogDirectory),
          closeStartupSplash: () => {
            const target = startupSplashWindow
            if (!target || target.isDestroyed()) return false
            target.close()
            return true
          },
          trayActivate: activation => trayManager?.activate(activation) ?? false,
          traySetState: state => {
            trayManager?.setState(state)
            syncDockBadge(app.dock, state.unreadCount, developmentDockIdentity?.badge)
            void trayNativeStatus?.refresh()
          },
          traySnapshot: () => {
            const snapshot = trayManager?.snapshot()
            return snapshot ? { ...snapshot, dockBadge: app.dock?.getBadge() ?? null } : null
          },
          openWorkspace: openWorkspaceWindow,
          showMain: reactivateMainWindow,
          closeWorkspace: label => {
            const target = workspaceWindows.get(label)
            if (!target || target.isDestroyed()) throw new Error('Workspace window is unavailable')
            target.close()
          },
          openPopoutTaskInMain: taskAddressId => {
            popoutWindow?.hide()
            dispatchTrayAction({ type: 'open-task', source: 'popout', taskId: taskAddressId })
          },
          popoutWindowSnapshot: () => ({
            bounds: popoutWindow && !popoutWindow.isDestroyed() ? popoutWindow.getBounds() : null,
            exists: Boolean(popoutWindow && !popoutWindow.isDestroyed()),
            focused: Boolean(
              popoutWindow && !popoutWindow.isDestroyed() && popoutWindow.isFocused()
            ),
            visible: Boolean(
              popoutWindow && !popoutWindow.isDestroyed() && popoutWindow.isVisible()
            ),
            windowId: popoutWindow && !popoutWindow.isDestroyed() ? popoutWindow.id : null,
            webContentsId:
              popoutWindow && !popoutWindow.isDestroyed() ? popoutWindow.webContents.id : null,
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
          runtimeDiagnostics: () => ({
            ...(desktopRuntime?.diagnostics() ?? {
              coreDshPid: null,
              developmentPlugin: null,
              executorPid: null,
              workbenchRuntimes: [],
            }),
            release: {
              id: process.env.WEWORK_ACTIVE_RELEASE_ID ?? null,
              hostExecutable: process.execPath,
              runtimeRoot: startupRuntimeEnvironment?.WEWORK_HARNESS_RUNTIME_ROOT,
              coreDshPath: startupRuntimeEnvironment?.WEWORK_HARNESS_RESOURCE_ROOT,
              corePluginsPath: startupRuntimeEnvironment?.WEWORK_CORE_PLUGIN_ROOT,
              executorPath: startupRuntimeEnvironment?.WEWORK_EXECUTOR_PATH,
              codexPath: startupRuntimeEnvironment?.CODEX_BINARY_PATH,
              dwsPath: startupRuntimeEnvironment?.DWS_BINARY_PATH,
            },
          }),
          scheduleCoreDshRestart,
          setSystemDragContext: context => {
            systemDragContext = context
          },
          setPopoutMode: mode => {
            const previousMode = popoutWindowMode
            popoutWindowMode = mode
            resizePopoutWindow(previousMode, mode)
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
    codexSubscriptionActiveAtStartup: codexSubscriptionEnabled,
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
      setEnabled: enabled => service.restoreEnabled(enabled),
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
  lastStartupFailure = null
  startStartupMaintenance('development status', () =>
    pluginDevelopmentChildRuntime?.writeState('starting')
  )
  notifyRuntimeChanged()
  runtimeStartPromise = (async () => {
    await configureDesktopRuntime()
    logStartupStep('core-dsh-start', 'started')
    startupProgress.report('core-dsh')
    await desktopRuntime?.start()
    logStartupStep('core-dsh-start', 'completed')
    if (packagedApplication && process.platform === 'win32')
      startStartupMaintenance('installed release registration', async () => {
        const installed = await appUpdates.reconcileInstalledRelease(
          (await runningDesktopComponents()).paths
        )
        if (installed) process.env.WEWORK_ACTIVE_RELEASE_ID = installed.id
      })
    startStartupMaintenance('tray status', () => trayNativeStatus?.start())
    await loadPrimaryDshView()
    startStartupMaintenance('workspace window restoration', restoreFixedWorkspaceWindows)
    startStartupMaintenance('component startup confirmation', () =>
      componentUpdates?.confirmStartup()
    )
    runtimePhase = lastStartupFailure ? 'failed' : 'ready'
    if (lastStartupFailure) return
    startStartupMaintenance('development watcher', () =>
      pluginDevelopmentChildRuntime?.startWatcher()
    )
    startStartupMaintenance('development status', () =>
      pluginDevelopmentChildRuntime?.writeState('ready')
    )
    logStartupStep('desktop-runtime-start', 'completed')
    startupTelemetrySuccess.markRuntimeReady()
  })()
    .catch(async error => {
      const failurePublished = startupTelemetry.fail('desktop_runtime')
      try {
        if (await componentUpdates?.rollbackStartup()) {
          console.error(
            '[components] startup failed after activation; rolling back and relaunching'
          )
          if (failurePublished) {
            const failureSequence = desktopHostEvents.latestSequence()
            await Promise.race([
              desktopHostEvents.waitUntilRead(failureSequence),
              new Promise<void>(resolve => setTimeout(resolve, 1_500)),
            ])
          }
          app.relaunch()
          app.exit(1)
          return
        }
      } catch (rollbackError) {
        console.error('[components] rollback compatibility check failed; refusing relaunch')
        error = rollbackError
      }
      recordStartupFailure(error, 'desktop_runtime')
      startStartupMaintenance('development error status', () =>
        pluginDevelopmentChildRuntime?.writeState(
          'error',
          error instanceof Error ? error : new Error(String(error))
        )
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
  app
    .whenReady()
    .then(async () => {
      logStartupStep('electron-ready', 'completed')
      if (process.platform === 'darwin' && app.dock && developmentDockIdentity) {
        syncDockBadge(app.dock, 0, developmentDockIdentity.badge)
        console.info('[development] Dock identity configured', developmentDockIdentity)
      }
      logStartupStep('log-retention-start', 'started')
      startStartupMaintenance('log retention', () => logRetention.start())
      if (keepE2EWindowInBackground) {
        app.hide()
        app.dock?.hide()
        dockVisible = false
      }
      preferences = new PreferencesStore(app.getPath('userData'))
      mainWindowState = new MainWindowStateController(preferences, error =>
        console.error('[window-state] Failed to save main window geometry', error)
      )
      desktopPreferences = new DesktopPreferencesController(preferences, {
        isShuttingDown: () => quitting,
        configurePopoutShortcut: shortcut => popoutShortcut?.configure(shortcut),
        setPerformanceRecordingEnabled: async enabled => {
          if (quitting && enabled) throw new Error('The application is shutting down')
          if (!performanceRecorder) throw new Error('Performance recorder is unavailable')
          await performanceRecorder.setEnabled(enabled)
        },
      })
      rendererStorage = createDesktopRendererStorage(app.getPath('userData'), {
        enabled: pythonRuntimeEnabled,
        isShuttingDown: () => quitting,
        python: () => pythonRuntimeManagerPromise,
        development: () => pluginDevelopment,
      })
      logStartupStep('desktop-stores-create', 'completed')
      if (!pluginDevelopmentInstance) {
        popoutShortcut = new GlobalShortcutController(globalShortcut, togglePopoutWindow, error =>
          console.error('[popout-window] global shortcut failed', error)
        )
      }
      cloudCredentials = new CloudCredentialService(app.getPath('userData'))
      startupRecovery = new StartupRecoveryService({
        rendererStorage,
        preferences,
        cloudCredentials,
        prepareCleanup: async () => {
          await runtimeStartPromise
          await prepareApplicationShutdown()
          disposeCoreDshViews()
          if (mainWindow && !mainWindow.isDestroyed()) {
            await mainWindow.webContents.loadURL('about:blank')
          }
        },
        clearRuntimeFiles: () => clearStartupRuntimeFiles(app.getPath('userData')),
        clearUserFiles: () => {
          const environment = startupRuntimeEnvironment ?? process.env
          const home = environment.WEGENT_EXECUTOR_HOME?.trim() || executorHome
          return clearStartupUserFiles({
            dataDirectory: app.getPath('userData'),
            codexHome: environment.WEGENT_CODEX_HOME?.trim() || join(home, 'codex'),
            claudeHome: environment.WEGENT_CLAUDE_HOME?.trim() || join(home, 'claude'),
            capabilitiesHome:
              environment.WEGENT_CAPABILITIES_HOME?.trim() || join(home, 'capabilities'),
            protectedAgentHomes: [
              join(app.getPath('home'), '.codex'),
              join(app.getPath('home'), '.claude'),
            ],
          })
        },
        clearCache: () => session.defaultSession.clearCache(),
        clearAppStorage: () =>
          session.defaultSession.clearStorageData({
            storages: ['serviceworkers', 'cachestorage'],
          }),
        clearUserStorage: () =>
          session.defaultSession.clearStorageData({
            storages: ['cookies', 'localstorage', 'indexdb'],
          }),
        disablePlugin: async name => {
          if (!desktopRuntime) throw new Error('Desktop runtime is unavailable')
          await desktopRuntime.setCoreDshPluginEnabled(name, false)
        },
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
              typeof current?.closeToTrayHintSeen === 'boolean'
                ? current.closeToTrayHintSeen
                : false,
          }
        },
        markCloseToTrayHintSeen: async () => {
          await preferences?.update({ closeToTrayHintSeen: true })
        },
      })
      if (!pluginDevelopmentInstance) {
        const createdTrayManager = createTrayManager()
        try {
          createdTrayManager.create()
          trayManager = createdTrayManager
        } catch (error) {
          console.warn('[tray] failed to create tray', error)
        }
      }
      const startupPreferences = await preferences.read()
      desktopAppearance.update(startupPreferences)
      nativeTheme.on('updated', () => desktopAppearance.update())
      logStartupStep('startup-preferences-read', 'completed')
      try {
        popoutShortcut?.configure(resolvePopoutShortcut(startupPreferences))
      } catch (error) {
        console.warn('[popout-window] failed to register global shortcut', error)
      }
      // Install the menu before any window is created so the
      // browser-window-created focus hook covers every workbench window.
      try {
        installApplicationMenu()
      } catch (error) {
        console.warn('[menu] failed to install application menu', error)
      }
      await createWindow(
        resolveStartupSplashTheme(
          startupPreferences.appearanceMode,
          nativeTheme.shouldUseDarkColors
        ),
        startupPreferences.mainWindowState
      )
      void startDesktopRuntime()
    })
    .catch(error => {
      console.error('[startup] failed to initialize desktop host', error)
      void showStartupRecovery(error)
        .then(() => {
          mainWindow?.hide()
          startupSplashWindow?.hide()
        })
        .catch(recoveryError => console.error('[startup] recovery window failed', recoveryError))
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

function desktopComponentResourcesRoot(): string {
  const resourcesRoot = packagedApplication
    ? (installedMacosReleaseResources() ?? process.resourcesPath)
    : developmentResourcesRoot
  const configuredComponentResourcesRoot = process.env.WEWORK_COMPONENT_RESOURCES_ROOT?.trim()
  return !packagedApplication && configuredComponentResourcesRoot
    ? resolve(configuredComponentResourcesRoot)
    : resourcesRoot
}

function runningDesktopComponents(): Promise<PreparedDesktopComponents> {
  desktopComponentsPromise ??= prepareDesktopComponents({
    isPackaged: packagedApplication,
    managerOptions: {
      validateExecutor: path =>
        assertExecutorWorkbenchCompatibility({
          ...process.env,
          WEWORK_EXECUTOR_PATH: process.env.WEWORK_EXECUTOR_PATH?.trim() || path,
        }),
      log: event => appUpdateLogger.info(event),
      resourcesRoot: desktopComponentResourcesRoot(),
      dataDirectory: process.env.WEWORK_COMPONENT_DATA_DIRECTORY?.trim() || app.getPath('userData'),
      updateBaseUrl,
      currentAppVersion: app.getVersion(),
    },
  }).catch(error => {
    desktopComponentsPromise = null
    throw error
  })
  return desktopComponentsPromise
}

async function desktopEnvironment(): Promise<NodeJS.ProcessEnv> {
  const componentResourcesRoot = desktopComponentResourcesRoot()
  startupProgress.report('components')
  logStartupStep('desktop-components-prepare', 'started')
  const preparedComponents = await runningDesktopComponents()
  logStartupStep('desktop-components-prepare', 'completed')
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
  logStartupStep('core-runtime-materialize', 'started')
  if (!configuredRuntimeRoot && components) startupProgress.report('runtime-files')
  const runtimeRoot = configuredRuntimeRoot
    ? configuredRuntimeRoot
    : components
      ? await materializeBundledRuntimes(
          components.coreDsh,
          packagedHarnessRuntimePaths().cache,
          ['core'],
          {
            onProgress: ({ stage, phase, elapsedMs, role, archiveBytes }) =>
              logStartupStep(`core-runtime-${stage}`, phase, {
                phaseElapsedMs: elapsedMs,
                role,
                archiveBytes,
              }),
          }
        )
      : developmentRuntimeRoot
  logStartupStep('core-runtime-materialize', 'completed')
  logStartupStep('node-runtime-prepare', 'started')
  const nodeRuntime = await electronNodeRuntime()
  logStartupStep('node-runtime-prepare', 'completed')
  const pythonRuntime = await managedPythonRuntime()
  console.info('[python-runtime]', {
    event: 'python-runtime-bootstrap-configured',
    enabled: pythonRuntimeEnabled,
    platform: process.platform,
    arch: process.arch,
  })
  const cliBin = join(app.getPath('userData'), 'runtime', 'wework-cli-bin')
  const nodeCommand =
    nodeRuntime.status.source === 'electron' && process.platform === 'darwin'
      ? [join(nodeRuntime.environment.WEWORK_RUNTIME_BIN!, 'node')]
      : [nodeRuntime.status.path]
  startupProgress.report('cli')
  logStartupStep('wework-cli-install', 'started')
  startStartupMaintenance('Wework CLI installation', async () => {
    await installWeworkCli(
      cliBin,
      resolve(packageRoot, 'dist', 'cli', 'wework-cli.mjs'),
      process.platform,
      {
        appCommand: weworkCliAppCommand(),
        nodeCommand,
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
            nodeCommand,
          }
        )
      } else {
        console.warn(`Wework CLI install path is not managed by Wework: ${userCliPath}`)
      }
    }
    logStartupStep('wework-cli-install', 'completed')
  })
  nodeRuntime.environment.PATH = [cliBin, nodeRuntime.environment.PATH?.trim()]
    .filter(Boolean)
    .join(delimiter)
  const runtimeEnvironment = pythonRuntimeEnabled
    ? pythonRuntime.environment()
    : { ...nodeRuntime.environment }
  if (pythonRuntimeEnabled)
    runtimeEnvironment.PATH = [cliBin, runtimeEnvironment.PATH?.trim()]
      .filter(Boolean)
      .join(delimiter)
  startupProgress.report('workspace')
  logStartupStep('workbench-environment', 'started')
  const environment = await prepareWorkbenchEnvironment({
    environment: {
      ...runtimeEnvironment,
      WEWORK_HARNESS_RUNTIME_ROOT: runtimeRoot,
      WEWORK_HARNESS_RESOURCE_ROOT:
        components?.coreDsh ?? join(componentResourcesRoot, 'harness-runtime'),
      ...(components
        ? {
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
    metadata: packageMetadata,
    homeDirectory: app.getPath('home'),
  })
  logStartupStep('workbench-environment', 'completed')
  if (environment.WEWORK_DEVELOPMENT_ISOLATED === '1') {
    await assertExecutorWorkbenchCompatibility(environment)
    logStartupStep('development-history', 'started')
    await prepareDevelopmentHistory(
      environment,
      app.getPath('userData'),
      process.env.HOME?.trim() || app.getPath('home')
    )
    logStartupStep('development-history', 'completed')
  }
  return environment
}

function weworkCliAppCommand(): string[] {
  return packagedApplication ? [process.execPath] : [process.execPath, packageRoot]
}

function desktopControlRegistryDirectory(): string {
  return (
    process.env.WEWORK_DESKTOP_CONTROL_REGISTRY_DIR?.trim() ||
    join(
      resolveWorkbenchPaths({
        environment: process.env,
        metadata: packageMetadata,
        homeDirectory: app.getPath('home'),
      }).shared,
      'desktop-instances'
    )
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
    const runtime = await prepareElectronNodeRuntime({
      dataDirectory: app.getPath('userData'),
      environment: {
        ...process.env,
        ...(nodePath ? { WEWORK_NODE_PATH: nodePath } : {}),
      },
      helperExecPath: (process as NodeJS.Process & { helperExecPath: string }).helperExecPath,
      nodeVersion: nodePath ? '' : process.versions.node,
      platform: process.platform,
    })
    if (nodePath) {
      startStartupMaintenance('Node version discovery', async () => {
        runtime.status.version = await readNodeVersion(nodePath)
      })
    }
    return runtime
  })()
  return electronNodeRuntimePromise
}

async function pythonRuntimeDownloads() {
  if (process.env.WEWORK_PARENT_PYTHON_DOWNLOADS_URL) {
    return fetchParentPythonRuntimeDownloads(process.env, cloudFetch)
  }
  return fetchPythonRuntimeDownloads({
    connection: () => {
      if (!rendererStorage) throw new PythonRuntimeLoginRequiredError()
      return readCloudConnection(rendererStorage)
    },
    accessToken: async (api, connection) => {
      if (
        connection.credentialMode !== 'desktop_refresh' &&
        typeof connection.token === 'string' &&
        connection.token
      )
        return connection.token
      try {
        return (
          await requiredCloudCredentials().refreshAccessToken(
            api,
            requireCloudCredentialOwner(connection, api)
          )
        ).accessToken
      } catch (error) {
        if (
          error instanceof CloudCredentialError &&
          ['credentials_unavailable', 'cloud_auth_expired'].includes(error.code)
        )
          throw new PythonRuntimeLoginRequiredError()
        throw error
      }
    },
    fetch: cloudFetch,
  })
}

function managedPythonRuntime(): Promise<PythonRuntimeManager> {
  pythonRuntimeManagerPromise ??= electronNodeRuntime().then(nodeRuntime => {
    return new PythonRuntimeManager({
      dataDirectory: app.getPath('userData'),
      environment: nodeRuntime.environment,
      resolveDownloads: pythonRuntimeDownloads,
      hasPluginDemand: async () => {
        if (!desktopRuntime || quitting) return false
        const result = await desktopRuntime.requestExecutor<{ demanded: boolean }>(
          'runtime.python.has_demand'
        )
        return result.demanded === true
      },
      fetch: cloudFetch,
      resolveProxy: targetUrl => resolveSystemProxy(session.defaultSession, targetUrl),
      log: event => console.info('[python-runtime]', event),
      onStatusChange: status => desktopHostEvents.publish('python-runtime-status', { ...status }),
    })
  })
  return pythonRuntimeManagerPromise
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

registerApplicationActivation(app, {
  keepInBackground: () => keepE2EWindowInBackground && !e2eForegroundActivationAllowed,
  openMainWindow: reactivateMainWindow,
  reportError: error => {
    console.error('[window] failed to reactivate main window', error)
  },
})

app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  requestApplicationShutdown(() => app.quit())
})

app.on('quit', () => {
  recordReleaseDiagnostic(
    'application-quit',
    { pid: process.pid, platform: process.platform, osRelease: release() },
    true
  )
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
