import { describe, expect, test, vi } from 'vitest'
import { createSingleFlight, presentWindow, type PresentableWindow } from './window-presentation.js'

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
