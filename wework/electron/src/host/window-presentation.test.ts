import { describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createSingleFlight,
  presentWindow,
  registerApplicationActivation,
  type PresentableWindow,
} from './window-presentation.js'

describe('application activation', () => {
  function setup(keepInBackground = false) {
    const application = Object.assign(new EventEmitter(), { hide: vi.fn() })
    const actions = {
      keepInBackground: () => keepInBackground,
      openMainWindow: vi.fn(async () => undefined),
      reportError: vi.fn(),
    }
    registerApplicationActivation(application, actions)
    return { application, actions }
  }

  test('does not open the main window when focusing an auxiliary window activates the app', () => {
    const { application, actions } = setup()
    application.emit('did-become-active')
    expect(actions.openMainWindow).not.toHaveBeenCalled()
    expect(application.hide).not.toHaveBeenCalled()
  })

  test('still opens the main window for an explicit Dock activation', () => {
    const { application, actions } = setup()
    application.emit('activate')
    application.emit('did-become-active')
    expect(actions.openMainWindow).toHaveBeenCalledOnce()
  })

  test('preserves background verification until foreground activation is allowed', () => {
    const { application, actions } = setup(true)
    application.emit('activate')
    application.emit('did-become-active')
    expect(actions.openMainWindow).not.toHaveBeenCalled()
    expect(application.hide).toHaveBeenCalledOnce()
  })

  test('reports a main-window activation failure', async () => {
    const { application, actions } = setup()
    const error = new Error('Window unavailable')
    actions.openMainWindow.mockRejectedValueOnce(error)
    application.emit('activate')
    await Promise.resolve()
    expect(actions.reportError).toHaveBeenCalledWith(error)
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

    expect(presentWindow(target)).toBe(true)

    expect(target.restore).toHaveBeenCalledOnce()
    expect(target.show).toHaveBeenCalledOnce()
    expect(target.focus).toHaveBeenCalledOnce()
    expect(webContents.focus).toHaveBeenCalledOnce()
  })

  test('does not interact with a destroyed native window', () => {
    const { target, webContents } = createWindow({ destroyed: true })

    expect(presentWindow(target)).toBe(false)

    expect(target.restore).not.toHaveBeenCalled()
    expect(target.show).not.toHaveBeenCalled()
    expect(target.focus).not.toHaveBeenCalled()
    expect(webContents.focus).not.toHaveBeenCalled()
  })

  test('keeps the native window usable when its renderer was destroyed', () => {
    const { target, webContents } = createWindow()
    webContents.isDestroyed.mockReturnValue(true)

    expect(presentWindow(target)).toBe(true)

    expect(target.show).toHaveBeenCalledOnce()
    expect(target.focus).toHaveBeenCalledOnce()
    expect(webContents.focus).not.toHaveBeenCalled()
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
