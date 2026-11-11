import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
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
import { presentWindow } from './window-presentation.js'

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
