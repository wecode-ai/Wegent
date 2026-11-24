import { describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createSingleFlight,
  presentWindow,
  presentWorkbenchWindow,
  registerApplicationActivation,
  type PresentableWindow,
} from './window-presentation.js'
import { takeCorrelatedActivationRequest } from './window-activation-diagnostics.js'

const electronMocks = vi.hoisted(() => ({ appActive: false, throwOnActive: false }))

vi.mock('electron', () => ({
  app: {
    isActive: () => {
      if (electronMocks.throwOnActive) throw new Error('isActive failed')
      return electronMocks.appActive
    },
    isHidden: () => false,
  },
  BrowserWindow: { getFocusedWindow: () => null },
}))

const testPresentation = {
  reason: 'test-present',
  initiator: 'system' as const,
  userInitiated: null,
}

async function flushPresentationLogging(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5))
}

function activationHarness() {
  // Drain any correlation request left behind by an earlier test so
  // attribution assertions stay deterministic.
  takeCorrelatedActivationRequest()
  const application = Object.assign(new EventEmitter(), { hide: vi.fn() })
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  return { application, info }
}

function activationLines(info: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return info.mock.calls
    .map(([line]) => (typeof line === 'string' ? line : ''))
    .filter(line => line.startsWith('[window-activation] '))
    .map(line => JSON.parse(line.slice('[window-activation] '.length)) as Record<string, unknown>)
}

describe('application activation', () => {
  test('does not reactivate the workbench when focusing an auxiliary window activates the app', () => {
    const application = Object.assign(new EventEmitter(), { hide: vi.fn() })
    const actions = {
      keepInBackground: () => false,
      openWorkbenchWindow: vi.fn(async () => undefined),
      reportError: vi.fn(),
    }
    registerApplicationActivation(application, actions)
    application.emit('did-become-active')
    expect(actions.openWorkbenchWindow).not.toHaveBeenCalled()
    expect(application.hide).not.toHaveBeenCalled()
  })

  test('still reactivates the workbench for an explicit Dock activation', () => {
    const application = Object.assign(new EventEmitter(), { hide: vi.fn() })
    const actions = {
      keepInBackground: () => false,
      openWorkbenchWindow: vi.fn(async () => undefined),
      reportError: vi.fn(),
    }
    registerApplicationActivation(application, actions)
    application.emit('activate')
    application.emit('did-become-active')
    expect(actions.openWorkbenchWindow).toHaveBeenCalledOnce()
  })

  test('preserves background verification until foreground activation is allowed', () => {
    const application = Object.assign(new EventEmitter(), { hide: vi.fn() })
    const actions = {
      keepInBackground: () => true,
      openWorkbenchWindow: vi.fn(async () => undefined),
      reportError: vi.fn(),
    }
    registerApplicationActivation(application, actions)
    application.emit('activate')
    application.emit('did-become-active')
    expect(actions.openWorkbenchWindow).not.toHaveBeenCalled()
    expect(application.hide).toHaveBeenCalledOnce()
  })

  test('reports a workbench activation failure', async () => {
    const application = Object.assign(new EventEmitter(), { hide: vi.fn() })
    const actions = {
      keepInBackground: () => false,
      openWorkbenchWindow: vi.fn(async () => undefined),
      reportError: vi.fn(),
    }
    registerApplicationActivation(application, actions)
    const error = new Error('Window unavailable')
    actions.openWorkbenchWindow.mockRejectedValueOnce(error)
    application.emit('activate')
    await Promise.resolve()
    expect(actions.reportError).toHaveBeenCalledWith(error)
  })
})

describe('did-become-active correlation', () => {
  test('attributes an activation that follows a background presentation', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    electronMocks.appActive = false
    const { application, info } = activationHarness()
    try {
      const actions = {
        keepInBackground: () => false,
        openWorkbenchWindow: vi.fn(async () => undefined),
        reportError: vi.fn(),
      }
      registerApplicationActivation(application, actions)
      const { target } = createWindow()
      presentWindow(target, {
        reason: 'popout-show',
        initiator: 'user',
        userInitiated: true,
        target: 'popout',
      })
      application.emit('did-become-active')
      await flushPresentationLogging()

      const lines = activationLines(info)
      const didBecomeActive = lines.find(line => line.reason === 'did-become-active')
      expect(didBecomeActive).toBeDefined()
      expect(didBecomeActive?.initiator).toBe('user')
      expect(didBecomeActive?.userInitiated).toBe(true)
      expect(didBecomeActive?.activationOutcome).toBe('requested')
      expect(didBecomeActive?.requestedReason).toBe('popout-show')
    } finally {
      info.mockRestore()
      electronMocks.appActive = false
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  test('carries the redacted deep link through scheme-open presentations', async () => {
    electronMocks.appActive = false
    const { info } = activationHarness()
    try {
      const { target } = createWindow()
      presentWindow(target, {
        reason: 'scheme-open',
        initiator: 'external_or_user',
        userInitiated: null,
        target: 'main',
        url: 'wework://tasks/dev-1/task-9?token=secret-secret',
      })
      await flushPresentationLogging()

      const lines = activationLines(info)
      const line = lines.find(item => item.reason === 'scheme-open')
      expect(line?.url).toBe('wework://tasks/dev-1/task-9?token=*')
      // This presentation registered a correlation request that no
      // did-become-active consumed; drain it so later tests stay isolated.
    } finally {
      info.mockRestore()
      takeCorrelatedActivationRequest()
      electronMocks.appActive = false
    }
  })

  test('does not register correlation on non-darwin platforms where activity is unknown', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      electronMocks.appActive = false
      const { application, info } = activationHarness()
      const actions = {
        keepInBackground: () => false,
        openWorkbenchWindow: vi.fn(async () => undefined),
        reportError: vi.fn(),
      }
      registerApplicationActivation(application, actions)
      const { target } = createWindow()
      presentWindow(target, {
        reason: 'popout-show',
        initiator: 'user',
        userInitiated: true,
        target: 'popout',
      })
      application.emit('did-become-active')
      await flushPresentationLogging()

      const lines = activationLines(info)
      expect(lines.find(line => line.reason === 'did-become-active')).toBeUndefined()
      const presentation = lines.find(line => line.reason === 'popout-show')
      expect(presentation?.appActiveBefore).toBeNull()
      info.mockRestore()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      electronMocks.appActive = false
    }
  })

  test('does not misattribute a user switch after a presentation while the app was active', async () => {
    electronMocks.appActive = true
    const { application, info } = activationHarness()
    try {
      const actions = {
        keepInBackground: () => false,
        openWorkbenchWindow: vi.fn(async () => undefined),
        reportError: vi.fn(),
      }
      registerApplicationActivation(application, actions)
      const { target } = createWindow()
      presentWindow(target, {
        reason: 'workspace-open',
        initiator: 'unknown',
        userInitiated: null,
        target: 'workspace-1',
      })
      application.emit('did-become-active')
      await flushPresentationLogging()

      const lines = activationLines(info)
      expect(lines.find(line => line.reason === 'did-become-active')).toBeUndefined()
      expect(lines.find(line => line.reason === 'workspace-open')).toBeDefined()
    } finally {
      info.mockRestore()
      electronMocks.appActive = false
    }
  })

  test('consumes the pending request when focus synchronously emits did-become-active', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    electronMocks.appActive = false
    const { application, info } = activationHarness()
    try {
      const actions = {
        keepInBackground: () => false,
        openWorkbenchWindow: vi.fn(async () => undefined),
        reportError: vi.fn(),
      }
      registerApplicationActivation(application, actions)
      const { target } = createWindow()
      target.focus = vi.fn(() => {
        application.emit('did-become-active')
      })

      presentWindow(target, {
        reason: 'popout-show',
        initiator: 'user',
        userInitiated: true,
        target: 'popout',
      })
      await flushPresentationLogging()

      const lines = activationLines(info)
      const didBecomeActive = lines.find(line => line.reason === 'did-become-active')
      expect(didBecomeActive).toBeDefined()
      expect(didBecomeActive?.initiator).toBe('user')
      expect(didBecomeActive?.activationOutcome).toBe('requested')
      expect(didBecomeActive?.requestedReason).toBe('popout-show')
      const presentation = lines.find(line => line.reason === 'popout-show')
      expect(presentation?.correlationId).toBe(didBecomeActive?.correlationId)
    } finally {
      info.mockRestore()
      electronMocks.appActive = false
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})

function createWindow(input: { destroyed?: boolean; minimized?: boolean } = {}) {
  const webContents = {
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
  }
  const target = {
    focus: vi.fn(),
    isDestroyed: vi.fn(() => input.destroyed ?? false),
    isMinimized: vi.fn(() => input.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    webContents,
  } satisfies PresentableWindow
  return { target, webContents }
}

describe('presentWindow', () => {
  test('reveals and focuses a renderer without waiting for application content readiness', () => {
    const { target, webContents } = createWindow({ minimized: true })

    expect(presentWindow(target, testPresentation)).toBe(true)

    expect(target.restore).toHaveBeenCalledOnce()
    expect(target.show).toHaveBeenCalledOnce()
    expect(target.focus).toHaveBeenCalledOnce()
    expect(webContents.focus).toHaveBeenCalledOnce()
  })

  test('does not interact with a destroyed native window', () => {
    const { target, webContents } = createWindow({ destroyed: true })

    expect(presentWindow(target, testPresentation)).toBe(false)

    expect(target.restore).not.toHaveBeenCalled()
    expect(target.show).not.toHaveBeenCalled()
    expect(target.focus).not.toHaveBeenCalled()
    expect(webContents.focus).not.toHaveBeenCalled()
  })

  test('keeps the native window usable when its renderer was destroyed', () => {
    const { target, webContents } = createWindow()
    webContents.isDestroyed.mockReturnValue(true)

    expect(presentWindow(target, testPresentation)).toBe(true)

    expect(target.show).toHaveBeenCalledOnce()
    expect(target.focus).toHaveBeenCalledOnce()
    expect(webContents.focus).not.toHaveBeenCalled()
  })

  test('still shows and focuses when every diagnostics accessor throws', async () => {
    electronMocks.throwOnActive = true
    const { target: hostileTarget, webContents: hostileContents } = createWindow()
    hostileTarget.isFocused = () => {
      throw new Error('isFocused failed')
    }

    expect(presentWindow(hostileTarget, testPresentation)).toBe(true)

    expect(hostileTarget.show).toHaveBeenCalledOnce()
    expect(hostileTarget.focus).toHaveBeenCalledOnce()
    expect(hostileContents.focus).toHaveBeenCalledOnce()
    await flushPresentationLogging()
    electronMocks.appActive = false
    electronMocks.throwOnActive = false
  })
})

describe('presentWorkbenchWindow', () => {
  test('returns to the last focused detached window, including when minimized', () => {
    const main = createWindow().target
    const detached = createWindow({ minimized: true }).target

    expect(presentWorkbenchWindow(detached, main, testPresentation)).toBe(detached)
    expect(detached.restore).toHaveBeenCalledOnce()
    expect(detached.focus).toHaveBeenCalledOnce()
    expect(main.show).not.toHaveBeenCalled()
  })

  test('returns to the main window when the last focused detached window closed', () => {
    const main = createWindow().target
    const detached = createWindow({ destroyed: true }).target

    expect(presentWorkbenchWindow(detached, main, testPresentation)).toBe(main)
    expect(main.focus).toHaveBeenCalledOnce()
  })
})

describe('createSingleFlight', () => {
  test('shares an in-flight action and permits a later action after it settles', async () => {
    let resolveAction = () => {}
    const action = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveAction = resolve
        })
    )
    const singleFlight = createSingleFlight(action)

    const first = singleFlight()
    const second = singleFlight()
    expect(second).toBe(first)
    expect(action).toHaveBeenCalledOnce()
    resolveAction()
    await first

    const third = singleFlight()
    expect(action).toHaveBeenCalledTimes(2)
    resolveAction()
    await third
  })
})
