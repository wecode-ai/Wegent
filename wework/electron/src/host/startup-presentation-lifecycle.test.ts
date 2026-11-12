import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  createSourceFile,
  isCallExpression,
  isFunctionDeclaration,
  isVariableStatement,
  ScriptTarget,
  transpileModule,
} from 'typescript'
import { afterEach, expect, test, vi } from 'vitest'
import { MainWindowStateController } from './main-window-state.js'
import { createSingleFlight, presentWindow } from './window-presentation.js'
import { DesktopHostReadiness } from './desktop-host-readiness.js'
import { desktopE2EWindowOptions } from './e2e-window-policy.js'
import { StartupProgressReporter } from './startup-progress.js'
import { resolveStartupSplashTheme, StartupSplash } from './startup-splash.js'
import { startWorkbenchSession, workbenchStartupMode } from './workbench-startup-mode.js'

function productionFunction<T>(name: string, context: Record<string, unknown>): T {
  // Execute production functions without launching the Electron main process.
  const source = createSourceFile(
    'main.ts',
    readFileSync(new URL('../main.ts', import.meta.url), 'utf8'),
    ScriptTarget.Latest,
    true
  )
  const declaration = source.statements
    .filter(isFunctionDeclaration)
    .find(statement => statement.name?.text === name)
  const initializer = source.statements
    .filter(isVariableStatement)
    .flatMap(statement => statement.declarationList.declarations)
    .find(declaration => declaration.name.getText(source) === name)?.initializer
  const callback =
    declaration ?? (initializer && isCallExpression(initializer) ? initializer.arguments[0] : null)
  if (!callback) throw new Error(`The production function ${name} is missing`)
  const { outputText } = transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: ScriptTarget.ES2023 },
  })
  return runInNewContext(outputText, context)
}

function presentationHandler(context: Record<string, unknown>): (source: string) => Promise<void> {
  return productionFunction('presentStartupWindow', context)
}

afterEach(() => vi.useRealTimers())

test.each(['ready', 'quitting', 'destroyed', 'failed'] as const)(
  'rechecks the %s lifecycle after closing the splash on failed handoff',
  async state => {
    let releaseClose!: () => void
    let closeStarted!: () => void
    const closing = new Promise<void>(resolve => {
      closeStarted = resolve
    })
    const closed = new Promise<void>(resolve => {
      releaseClose = resolve
    })
    const window = {
      isDestroyed: vi.fn(() => false),
      setOpacity: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { focus: vi.fn() },
    }
    const start = vi.fn()
    const context = {
      mainWindow: window,
      backgroundWorkbenchStartup: false,
      quitting: false,
      lastStartupFailure: null as { message: string } | null,
      logStartupStep: vi.fn(),
      holdStartupSplashForDesktopE2e: async () => {},
      startupSplash: {
        handoff: vi.fn().mockRejectedValue(new Error('Animation failed')),
        close: vi.fn(async () => {
          closeStarted()
          await closed
        }),
      },
      startupSplashWindow: {},
      startupProgress: { complete: vi.fn() },
      mainWindowState: { start },
      keepE2EWindowInBackground: false,
      console: { warn: vi.fn() },
      process: { env: {} },
    }
    const pending = presentationHandler(context)('document-loaded')
    await closing
    if (state === 'quitting') context.quitting = true
    if (state === 'destroyed') window.isDestroyed.mockReturnValue(true)
    if (state === 'failed') context.lastStartupFailure = { message: 'Startup failed' }
    releaseClose()
    await pending
    const expected = state === 'ready' ? 1 : 0
    expect(start).toHaveBeenCalledTimes(expected)
    expect(window.focus).toHaveBeenCalledTimes(expected)
    expect(window.webContents.focus).toHaveBeenCalledTimes(expected)
  }
)

class StatefulWindow extends EventEmitter {
  bounds = { x: 120, y: 80, width: 1100, height: 700 }
  maximized = false
  shown = false
  isDestroyed = () => false
  isMinimized = () => false
  isFullScreen = () => false
  isMaximized = () => this.maximized
  getNormalBounds = () => ({ ...this.bounds })
  restore = vi.fn()
  setOpacity = vi.fn()
  maximize = vi.fn(() => {
    this.maximized = true
    this.emit('maximize')
  })
  show = vi.fn(() => {
    this.shown = true
    this.emit('show')
  })
  focus = vi.fn()
  webContents = { focus: vi.fn(), isDestroyed: () => false }
}

function backgroundFixture(maximized = false) {
  vi.useFakeTimers()
  const window = new StatefulWindow()
  const update = vi.fn(async (patch: Record<string, unknown>) => patch)
  const controller = new MainWindowStateController({ update }, vi.fn())
  const context = {
    mainWindow: window,
    mainWindowState: controller,
    backgroundWorkbenchStartup: true,
    workbenchForegroundRequested: false,
    quitting: false,
    lastStartupFailure: null,
    keepE2EWindowInBackground: false,
    logStartupStep: vi.fn(),
    holdStartupSplashForDesktopE2e: async () => {},
    startupSplash: { close: vi.fn(async () => {}) },
    startupSplashWindow: {},
    deferredWorkspaceWindowRestore: false,
    restoreFixedWorkspaceWindows: vi.fn(async () => {}),
    focusStartupRecoveryIfActive: vi.fn(() => false),
    focusStartupSplashIfActive: vi.fn(() => false),
    ensureWorkbenchWindow: vi.fn(async () => {}),
    setDockVisible: vi.fn(async () => {}),
    loadPrimaryDshView: vi.fn(async () => {}),
    presentWindow,
    presentMainWindow: presentWindow,
    console: { warn: vi.fn() },
  }
  productionFunction<(target: StatefulWindow, maximized: boolean) => void>(
    'restoreMainWindowOnFirstShow',
    context
  )(window, maximized)
  context.presentMainWindow = productionFunction('presentMainWindow', context)
  return {
    window,
    update,
    controller,
    context,
    ready: presentationHandler(context),
    activate: productionFunction<() => Promise<void>>('reactivateMainWindow', context),
  }
}

test('tracks background startup only after activation and preserves one tracker across repeated activation', async () => {
  const { window, update, controller, ready, activate } = backgroundFixture()
  await ready('document-loaded')
  expect(window.shown).toBe(false)
  window.emit('move')
  await vi.runAllTimersAsync()
  expect(update).not.toHaveBeenCalled()
  expect(window.listenerCount('move')).toBe(0)
  await activate()
  await activate()
  expect(window.shown).toBe(true)
  expect(window.listenerCount('move')).toBe(1)
  expect(window.listenerCount('closed')).toBe(1)
  window.bounds = { x: 200, y: 100, width: 900, height: 640 }
  window.maximized = true
  window.emit('move')
  window.emit('maximize')
  await controller.stop()
  expect(update).toHaveBeenCalledExactlyOnceWith({
    mainWindowState: { bounds: window.bounds, maximized: true },
  })
})

test('tracks activation received while the hidden startup splash is closing', async () => {
  const { window, update, controller, context, ready, activate } = backgroundFixture()
  let releaseClose!: () => void
  let startedClose!: () => void
  const closing = new Promise<void>(resolve => (startedClose = resolve))
  const closed = new Promise<void>(resolve => (releaseClose = resolve))
  context.startupSplash.close.mockImplementation(async () => {
    startedClose()
    await closed
  })
  const pending = ready('document-loaded')
  await closing
  context.focusStartupSplashIfActive.mockReturnValue(true)
  await activate()
  expect(window.shown).toBe(false)
  expect(window.listenerCount('move')).toBe(0)
  context.deferredWorkspaceWindowRestore = true
  releaseClose()
  await pending
  expect(window.shown).toBe(true)
  expect(window.listenerCount('move')).toBe(1)
  expect(context.restoreFixedWorkspaceWindows).toHaveBeenCalledOnce()
  context.focusStartupSplashIfActive.mockReturnValue(false)
  await activate()
  expect(window.listenerCount('move')).toBe(1)
  window.bounds.width = 940
  window.emit('resize')
  await controller.stop()
  expect(update).toHaveBeenCalledExactlyOnceWith({
    mainWindowState: { bounds: window.bounds, maximized: false },
  })
})

test('restores a saved maximized state on the first foreground show without revealing the hidden startup', async () => {
  const { window, update, controller, ready, activate } = backgroundFixture(true)
  await ready('document-loaded')
  expect(window.shown).toBe(false)
  expect(window.maximize).not.toHaveBeenCalled()
  await activate()
  expect(window.shown).toBe(true)
  expect(window.maximized).toBe(true)
  expect(window.listenerCount('move')).toBe(1)
  window.maximized = false
  window.emit('unmaximize')
  await activate()
  expect(window.maximize).toHaveBeenCalledOnce()
  expect(window.maximized).toBe(false)
  window.maximized = true
  window.emit('maximize')
  await controller.stop()
  expect(update).toHaveBeenCalledExactlyOnceWith({
    mainWindowState: { bounds: window.bounds, maximized: true },
  })
})

class StartupShellWindow extends EventEmitter {
  shown = false
  destroyed = false
  contentsDestroyed = false
  isDestroyed = () => this.destroyed
  isVisible = () => this.shown
  loadFile = vi.fn(async () => {})
  show = vi.fn(() => {
    this.shown = true
  })
  hide = vi.fn(() => {
    this.shown = false
  })
  maximize = vi.fn()
  setOpacity = vi.fn()
  close = vi.fn(() => {
    this.destroyed = true
    this.shown = false
    this.emit('closed')
  })
  webContents = {
    isDestroyed: () => this.destroyed || this.contentsDestroyed,
    send: vi.fn(),
    executeJavaScript: vi.fn(async () => true),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('splash') })),
  }
}

/** Execute the production bootstrap, shell creation and activation with native boundaries stubbed. */
function startupFixture(applicationOnly = false, trial = false, loadFailure?: 'shell' | 'splash') {
  const windows: StartupShellWindow[] = []
  const recoveryWindow = new StartupShellWindow()
  const stages: string[] = []
  const events: string[] = []
  const readiness = new DesktopHostReadiness()
  let release!: () => void
  let configured!: () => void
  const configurationStarted = new Promise<void>(resolve => {
    configured = resolve
  })
  const configuration = new Promise<void>(resolve => {
    release = resolve
  })
  const progress = new StartupProgressReporter(update => {
    stages.push(update.stage.id)
    context.startupSplash?.updateProgress(update)
  })
  const context = {
    mainWindow: null as StartupShellWindow | null,
    startupSplashWindow: null as StartupShellWindow | null,
    startupSplash: null as StartupSplash | null,
    startupProgress: progress,
    desktopHostReadiness: readiness,
    recordStartupFailure: vi.fn(),
    showStartupRecovery: vi.fn<(error: unknown) => Promise<StartupShellWindow>>(async () => {
      recoveryWindow.show()
      return recoveryWindow
    }),
    console: { error: vi.fn(), warn: vi.fn() },
    Error,
    startupWorkspaceOpenRequest: null,
    backgroundWorkbenchStartup: false,
    workbenchForegroundRequested: false,
    quitting: false,
    startupTiming: null,
    pluginDevelopmentInstance: false,
    developmentDockIdentity: null,
    process: {
      platform: process.platform,
      env: trial ? { WEWORK_ACTIVE_RELEASE_ID: 'target' } : {},
    },
    app: { getPath: () => '/test-profile' },
    ReleaseStore: class {
      root = '/test-profile/releases'
      async activation() {
        return { to: 'target', token: 'trial-token' }
      }
    },
    optionalText: async () => null,
    applicationLaunches: {
      hasPending: () => applicationOnly,
      start: vi.fn(async () => {
        events.push('applications-opened')
      }),
    },
    pendingSchemes: { read: () => [] },
    workbenchStartupMode,
    startWorkbenchSession,
    workbenchApplications: {
      start: vi.fn(async () => {
        events.push('host-started')
      }),
      open: vi.fn(async () => {}),
    },
    configureDesktopRuntime: vi.fn(async () => {
      events.push('configuration-started')
      progress.report('components')
      configured()
      await configuration
      for (const stage of ['cli', 'workspace', 'services']) progress.report(stage)
      events.push('configuration-completed')
    }),
    startDesktopRuntime: vi.fn(async () => {
      events.push('runtime-started')
      progress.report('core-dsh')
      progress.report('renderer')
      progress.complete()
    }),
    ensureDesktopControlBridge: vi.fn(async () => {
      events.push('control-started')
    }),
    requiredPreferences: () => ({ read: async () => ({ appearanceMode: 'light' }) }),
    resolveStartupSplashTheme,
    nativeTheme: { shouldUseDarkColors: false },
    BrowserWindow: class extends StartupShellWindow {
      constructor() {
        super()
        const shell = windows.length === 0
        if ((shell && loadFailure === 'shell') || (!shell && loadFailure === 'splash')) {
          this.loadFile.mockRejectedValue(new Error(`${loadFailure} load failed`))
        }
        windows.push(this)
      }
    },
    screen: {
      getDisplayNearestPoint: () => ({ workArea: {} }),
      getCursorScreenPoint: () => ({}),
      getAllDisplays: () => [],
    },
    startupWindowLayout: () => ({ bounds: {}, maximized: false }),
    desktopWindowFrameOptions: () => ({}),
    desktopE2EWindowOptions,
    workbenchBackgroundThrottling: () => false,
    dshPreloadPath: '/preload',
    startupSplashPreloadPath: '/splash-preload',
    installE2ERendererCpuProfiling: vi.fn(),
    restoreMainWindowOnFirstShow: vi.fn(),
    StartupSplash,
    keepE2EWindowInBackground: false,
    logStartupStep: vi.fn(),
    layoutPrimaryView: vi.fn(),
    packageRoot: '/package',
    resolve,
    join,
    createWindow: async () => {},
    createWorkbenchWindow: async () => {},
    ensureWorkbenchWindow: async () => {},
    focusStartupRecoveryIfActive: vi.fn(() => recoveryWindow.isVisible()),
    focusStartupSplashIfActive: () => context.startupSplash?.snapshot().state !== 'closed',
    setDockVisible: async () => {},
    presentMainWindow: vi.fn(),
    loadPrimaryDshView: async () => {},
    deferredWorkspaceWindowRestore: false,
    restoreFixedWorkspaceWindows: async () => {},
  }
  context.createWindow = productionFunction('createWindow', context)
  context.createWorkbenchWindow = createSingleFlight(
    productionFunction('createWorkbenchWindow', context)
  )
  context.ensureWorkbenchWindow = createSingleFlight(
    productionFunction('ensureWorkbenchWindow', context)
  )
  return {
    context,
    events,
    stages,
    windows,
    recoveryWindow,
    release,
    configurationStarted,
    progress,
    initialize: productionFunction<() => Promise<void>>('initializeDesktopSession', context),
    activate: productionFunction<() => Promise<void>>('reactivateMainWindow', context),
    fail: productionFunction<(error: Error) => Promise<void>>('failDesktopHostStartup', context),
  }
}

test('foreground startup shows real shells before Host configuration and preserves durable stages', async () => {
  const fixture = startupFixture()
  const pending = fixture.initialize()
  await fixture.configurationStarted
  expect(fixture.windows).toHaveLength(2)
  expect(fixture.windows[0].shown).toBe(false)
  expect(fixture.windows[1].shown).toBe(true)
  expect(fixture.stages).toEqual(['launch', 'shell', 'components'])
  expect(fixture.context.startDesktopRuntime).not.toHaveBeenCalled()
  fixture.release()
  await pending
  expect(fixture.progress.history().map(update => update.stage.id)).toEqual([
    'launch',
    'shell',
    'components',
    'cli',
    'workspace',
    'services',
    'core-dsh',
    'renderer',
  ])
  expect(fixture.events).toEqual([
    'configuration-started',
    'configuration-completed',
    'host-started',
    'runtime-started',
    'applications-opened',
  ])
  expect(fixture.windows).toHaveLength(2)
})

test('application-only startup creates no shells and later activation retains process progress', async () => {
  const fixture = startupFixture(true)
  const pending = fixture.initialize()
  await fixture.configurationStarted
  expect(fixture.windows).toHaveLength(0)
  fixture.release()
  await pending
  expect(fixture.windows).toHaveLength(0)
  expect(fixture.context.startDesktopRuntime).not.toHaveBeenCalled()
  expect(fixture.context.ensureDesktopControlBridge).toHaveBeenCalledOnce()
  await Promise.all([fixture.activate(), fixture.activate()])
  expect(fixture.windows).toHaveLength(2)
  expect(fixture.context.startDesktopRuntime).toHaveBeenCalledOnce()
  expect(fixture.context.configureDesktopRuntime).toHaveBeenCalledOnce()
  expect(fixture.progress.history().map(update => update.stage.id)).toEqual([
    'launch',
    'components',
    'cli',
    'workspace',
    'services',
    'core-dsh',
    'renderer',
  ])
  expect(fixture.stages.filter(stage => stage === 'launch')).toHaveLength(1)
  expect(fixture.windows[1].webContents.send).toHaveBeenCalledWith(
    'startup-progress:update',
    expect.objectContaining({ stage: expect.objectContaining({ id: 'services' }) })
  )
})

test('an early application-only activation waits for configured Host without duplicating windows or stages', async () => {
  const fixture = startupFixture(true)
  const pending = fixture.initialize()
  await fixture.configurationStarted
  const activation = fixture.activate()
  expect(fixture.windows).toHaveLength(0)
  fixture.release()
  await Promise.all([pending, activation])
  expect(fixture.windows).toHaveLength(2)
  expect(fixture.context.startDesktopRuntime).toHaveBeenCalledOnce()
  expect(fixture.stages.filter(stage => stage === 'launch')).toHaveLength(1)
})

test('an application trial prepares hidden shells before Host configuration', async () => {
  const fixture = startupFixture(true, true)
  const pending = fixture.initialize()
  await fixture.configurationStarted
  expect(fixture.context.backgroundWorkbenchStartup).toBe(true)
  expect(fixture.windows).toHaveLength(2)
  expect(fixture.windows.every(window => !window.shown)).toBe(true)
  expect(fixture.stages).toEqual(['launch', 'shell', 'components'])
  fixture.release()
  await pending
  expect(fixture.context.startDesktopRuntime).toHaveBeenCalledOnce()
})

test('closing an early splash during Host configuration does not start runtime or applications', async () => {
  const fixture = startupFixture()
  const pending = fixture.initialize()
  await fixture.configurationStarted
  fixture.context.quitting = true
  fixture.release()
  await pending
  expect(fixture.context.workbenchApplications.start).not.toHaveBeenCalled()
  expect(fixture.context.startDesktopRuntime).not.toHaveBeenCalled()
  expect(fixture.context.applicationLaunches.start).not.toHaveBeenCalled()
})

test('Host configuration is single-flight even before its runtime has been assigned', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  const context = {
    runtimeConfigurationPromise: null as Promise<void> | null,
    desktopRuntime: null as object | null,
    initializeDesktopRuntime: vi.fn(async () => {
      await pending
      context.desktopRuntime = {}
    }),
  }
  const configure = productionFunction<() => Promise<void>>('configureDesktopRuntime', context)
  const first = configure()
  expect(configure()).toBe(first)
  expect(context.initializeDesktopRuntime).toHaveBeenCalledOnce()
  release()
  await first
  await configure()
  expect(context.initializeDesktopRuntime).toHaveBeenCalledOnce()
})

test('shutdown waits for admitted configuration before disposing the services it creates', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  const dispose = vi.fn(async () => {})
  const context = {
    runtimeConfigurationPromise: pending,
    traceShutdownStep: async (_step: string, task: () => unknown) => task(),
    mainWindowState: null,
    pluginDevelopmentChildRuntime: null,
    performanceRecorder: null,
    logRetention: { stop: vi.fn() },
    workbenchApplications: null as { dispose: typeof dispose } | null,
    mcpAppCleanups: new Set(),
    settleMcpAppCleanup: async () => [],
    mcpAppRuntime: null,
    systemResume: { stop: vi.fn() },
    systemSleep: { stop: vi.fn() },
    trayNativeStatus: null,
    workspaceWindows: new Map(),
    disposeSystemDragWindow: vi.fn(),
    startupSplash: null,
    popoutWindow: null,
    popoutWindowCreationPromise: null,
    popoutWindowReadyPromise: null,
    popoutWindowMode: 'composer',
    popoutShortcut: null,
    embeddedBrowser: null,
    browserAnnotations: null,
    embeddedBrowserBridge: null,
    desktopControlBridge: null,
    computerUse: null,
    pluginDevelopment: null,
    desktopRuntime: null,
    localWorkspaceCatalogLog: { flush: async () => {} },
  }
  const closing = productionFunction<() => Promise<void>>('shutdown', context)()
  await Promise.resolve()
  expect(context.logRetention.stop).not.toHaveBeenCalled()
  context.workbenchApplications = { dispose }
  release()
  await closing
  expect(dispose).toHaveBeenCalledOnce()
})

test('Host configuration failure opens independent recovery before hiding startup surfaces', async () => {
  const fixture = startupFixture()
  const pending = fixture.initialize()
  await fixture.configurationStarted
  const error = new Error('Component preparation failed')
  expect(fixture.context.startupSplash?.snapshot()).toMatchObject({
    state: 'visible',
    window: { visible: true },
  })
  await fixture.fail(error)
  await expect(fixture.context.desktopHostReadiness.wait()).rejects.toBe(error)
  expect(fixture.context.recordStartupFailure).toHaveBeenCalledWith(error, 'desktop_host')
  expect(fixture.windows[1].webContents.executeJavaScript).not.toHaveBeenCalledWith(
    expect.stringContaining('wework-startup-error')
  )
  expect(fixture.context.showStartupRecovery).toHaveBeenCalledExactlyOnceWith(error)
  expect(fixture.recoveryWindow.isVisible()).toBe(true)
  expect(fixture.windows.every(window => !window.shown)).toBe(true)
  fixture.context.quitting = true
  fixture.release()
  await pending
})

test.each(['shell', 'splash'] as const)(
  'a failed %s load opens independent recovery without requiring splash readiness',
  async failingPage => {
    const fixture = startupFixture(false, false, failingPage)
    await expect(fixture.initialize()).rejects.toThrow(`${failingPage} load failed`)
    const error = new Error(`${failingPage} load failed`)
    expect(fixture.context.startupSplash?.snapshot()).toMatchObject({
      state: failingPage === 'splash' ? 'idle' : 'visible',
      window: { visible: failingPage !== 'splash' },
    })
    await fixture.fail(error)
    expect(fixture.context.showStartupRecovery).toHaveBeenCalledExactlyOnceWith(error)
    expect(fixture.recoveryWindow.isVisible()).toBe(true)
    expect(fixture.windows.every(window => !window.shown)).toBe(true)
    await expect(fixture.context.desktopHostReadiness.wait()).rejects.toBe(error)
    expect(fixture.windows[1].webContents.executeJavaScript).not.toHaveBeenCalledWith(
      expect.stringContaining('wework-startup-error')
    )
  }
)

test.each(['closed', 'contents-destroyed', 'hidden-trial', 'script-failed'] as const)(
  'Host failure opens independent recovery when the splash is %s',
  async unavailable => {
    const fixture = startupFixture(unavailable === 'hidden-trial', unavailable === 'hidden-trial')
    const pending = fixture.initialize()
    await fixture.configurationStarted
    const splashWindow = fixture.windows[1]
    if (unavailable === 'closed') splashWindow.close()
    if (unavailable === 'contents-destroyed') splashWindow.contentsDestroyed = true
    if (unavailable === 'script-failed') {
      splashWindow.webContents.executeJavaScript.mockRejectedValueOnce(new Error('Renderer failed'))
    }
    const error = new Error('Host initialization failed')
    await fixture.fail(error)
    expect(fixture.context.showStartupRecovery).toHaveBeenCalledExactlyOnceWith(error)
    expect(fixture.recoveryWindow.isVisible()).toBe(true)
    expect(fixture.windows.every(window => !window.shown)).toBe(true)
    await expect(fixture.context.desktopHostReadiness.wait()).rejects.toBe(error)
    expect(splashWindow.webContents.executeJavaScript).not.toHaveBeenCalledWith(
      expect.stringContaining('wework-startup-error')
    )
    fixture.context.quitting = true
    fixture.release()
    await pending
  }
)

test('Host failure during shutdown fails readiness without opening recovery', async () => {
  const fixture = startupFixture()
  const pending = fixture.initialize()
  await fixture.configurationStarted
  fixture.context.quitting = true
  const error = new Error('Host initialization failed')
  await fixture.fail(error)
  await expect(fixture.context.desktopHostReadiness.wait()).rejects.toBe(error)
  expect(fixture.context.showStartupRecovery).not.toHaveBeenCalled()
  expect(fixture.context.recordStartupFailure).not.toHaveBeenCalled()
  fixture.release()
  await pending
})

test('application-only Host failure opens recovery without creating normal shells', async () => {
  const fixture = startupFixture(true)
  const pending = fixture.initialize()
  await fixture.configurationStarted
  const error = new Error('Host initialization failed')
  await fixture.fail(error)
  expect(fixture.windows).toHaveLength(0)
  expect(fixture.context.showStartupRecovery).toHaveBeenCalledExactlyOnceWith(error)
  expect(fixture.recoveryWindow.isVisible()).toBe(true)
  await expect(fixture.context.desktopHostReadiness.wait()).rejects.toBe(error)
  fixture.context.quitting = true
  fixture.release()
  await pending
})

test('Host failure keeps existing startup surfaces until independent recovery is ready', async () => {
  const fixture = startupFixture()
  const pending = fixture.initialize()
  await fixture.configurationStarted
  let releaseRecovery!: () => void
  const recoveryReady = new Promise<void>(resolve => {
    releaseRecovery = resolve
  })
  fixture.context.showStartupRecovery.mockImplementationOnce(async () => {
    await recoveryReady
    fixture.recoveryWindow.show()
    return fixture.recoveryWindow
  })
  const error = new Error('Host initialization failed')
  const failing = fixture.fail(error)
  expect(fixture.context.showStartupRecovery).toHaveBeenCalledExactlyOnceWith(error)
  expect(fixture.recoveryWindow.isVisible()).toBe(false)
  expect(fixture.windows[1].isVisible()).toBe(true)
  expect(fixture.windows.every(window => window.hide.mock.calls.length === 0)).toBe(true)
  await expect(fixture.context.desktopHostReadiness.wait()).rejects.toBe(error)
  releaseRecovery()
  await failing
  expect(fixture.recoveryWindow.isVisible()).toBe(true)
  for (const window of fixture.windows) expect(window.hide).toHaveBeenCalledOnce()
  expect(fixture.windows.every(window => !window.shown)).toBe(true)
  fixture.context.quitting = true
  fixture.release()
  await pending
})

test('a recovery load failure preserves existing surfaces and the original Host failure', async () => {
  const fixture = startupFixture()
  const pending = fixture.initialize()
  await fixture.configurationStarted
  const recoveryError = new Error('Recovery could not load')
  fixture.context.showStartupRecovery.mockRejectedValueOnce(recoveryError)
  const error = new Error('Host initialization failed')
  await fixture.fail(error)
  expect(fixture.recoveryWindow.isVisible()).toBe(false)
  expect(fixture.windows[1].isVisible()).toBe(true)
  for (const window of fixture.windows) expect(window.hide).not.toHaveBeenCalled()
  await expect(fixture.context.desktopHostReadiness.wait()).rejects.toBe(error)
  expect(fixture.context.recordStartupFailure).toHaveBeenCalledExactlyOnceWith(
    error,
    'desktop_host'
  )
  expect(fixture.context.console.error).toHaveBeenCalledWith(
    '[startup] recovery window failed',
    recoveryError
  )
  fixture.context.quitting = true
  fixture.release()
  await pending
})

test('activation focuses active recovery without starting normal workbench services', async () => {
  const fixture = startupFixture(true)
  const error = new Error('Host initialization failed')
  await fixture.fail(error)
  await fixture.activate()
  expect(fixture.context.focusStartupRecoveryIfActive).toHaveBeenCalledOnce()
  expect(fixture.recoveryWindow.isVisible()).toBe(true)
  expect(fixture.windows).toHaveLength(0)
  expect(fixture.context.configureDesktopRuntime).not.toHaveBeenCalled()
  expect(fixture.context.startDesktopRuntime).not.toHaveBeenCalled()
  expect(fixture.context.ensureDesktopControlBridge).not.toHaveBeenCalled()
  expect(fixture.context.applicationLaunches.start).not.toHaveBeenCalled()
  await expect(fixture.context.desktopHostReadiness.wait()).rejects.toBe(error)
})

test('activation during shutdown does not focus recovery or create startup surfaces', async () => {
  const fixture = startupFixture(true)
  fixture.context.quitting = true
  await fixture.activate()
  expect(fixture.context.focusStartupRecoveryIfActive).not.toHaveBeenCalled()
  expect(fixture.context.configureDesktopRuntime).not.toHaveBeenCalled()
  expect(fixture.context.startDesktopRuntime).not.toHaveBeenCalled()
  expect(fixture.windows).toHaveLength(0)
})
