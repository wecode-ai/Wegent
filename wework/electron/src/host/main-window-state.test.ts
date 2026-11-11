import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MainWindowStateController } from './main-window-state.js'
import { PreferencesStore } from './preferences-store.js'
import { startupWindowLayout } from './window-layout.js'

class FakeWindow extends EventEmitter {
  bounds = { x: 120, y: 80, width: 1100, height: 700 }
  maximized = false
  minimized = false
  fullScreen = false
  destroyed = false
  getNormalBounds = () => ({ ...this.bounds })
  isMaximized = () => this.maximized
  isMinimized = () => this.minimized
  isFullScreen = () => this.fullScreen
  isDestroyed = () => this.destroyed
}

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function fixture() {
  vi.useFakeTimers()
  const update = vi.fn(async (patch: Record<string, unknown>) => patch)
  const onError = vi.fn()
  const controller = new MainWindowStateController({ update }, onError)
  const window = new FakeWindow()
  const start = () => controller.start(window as Parameters<typeof controller.start>[0])
  return { update, onError, controller, window, start }
}

describe('main window state persistence', () => {
  test('does not record hidden startup geometry before the handoff, and flushes on quit', async () => {
    const { controller, window, start, update } = fixture()
    window.emit('resize')
    await vi.runAllTimersAsync()
    expect(update).not.toHaveBeenCalled()
    start()
    window.bounds = { x: 220, y: 90, width: 1000, height: 650 }
    window.emit('resize')
    window.emit('move')
    expect(update).not.toHaveBeenCalled()
    await controller.stop()
    expect(update).toHaveBeenCalledExactlyOnceWith({
      mainWindowState: { bounds: window.bounds, maximized: false },
    })
    window.emit('resize')
    await vi.runAllTimersAsync()
    expect(update).toHaveBeenCalledTimes(1)
    expect(window.listenerCount('move')).toBe(0)
  })

  test('stores normal bounds while maximized and remembers unmaximize', async () => {
    const { controller, window, start, update } = fixture()
    start()
    window.maximized = true
    window.emit('maximize')
    await vi.runAllTimersAsync()
    expect(update).toHaveBeenLastCalledWith({
      mainWindowState: { bounds: window.bounds, maximized: true },
    })
    window.maximized = false
    window.emit('unmaximize')
    await controller.stop()
    expect(update).toHaveBeenLastCalledWith({
      mainWindowState: { bounds: window.bounds, maximized: false },
    })
  })

  test('repeated starts for the same window retain one set of listeners and one pending write', async () => {
    const { controller, window, start, update } = fixture()
    start()
    start()
    expect(window.listenerCount('move')).toBe(1)
    expect(window.listenerCount('resize')).toBe(1)
    expect(window.listenerCount('closed')).toBe(1)
    window.bounds.width = 920
    window.emit('resize')
    await vi.runAllTimersAsync()
    expect(update).toHaveBeenCalledExactlyOnceWith({
      mainWindowState: { bounds: window.bounds, maximized: false },
    })
    await controller.stop()
    expect(window.listenerCount('move')).toBe(0)
    expect(window.listenerCount('closed')).toBe(0)
  })

  test('rejects a different active window until the tracked window is stopped', async () => {
    const { controller, start, window, update } = fixture()
    const next = new FakeWindow()
    next.bounds = { x: 40, y: 60, width: 900, height: 600 }
    start()
    expect(() => controller.start(next)).toThrow('tracking is already active')
    expect(next.listenerCount('move')).toBe(0)
    expect(window.listenerCount('move')).toBe(1)
    await controller.stop()
    controller.start(next)
    expect(next.listenerCount('move')).toBe(1)
    await controller.stop()
    expect(update).toHaveBeenLastCalledWith({
      mainWindowState: { bounds: next.bounds, maximized: false },
    })
  })

  test.each(['minimized', 'fullScreen'] as const)(
    'retains normal bounds when quitting %s',
    async mode => {
      const { controller, window, start, update } = fixture()
      start()
      const normal = { x: 200, y: 90, width: 1000, height: 650 }
      window.bounds = normal
      window.emit('resize')
      window[mode] = true
      window.bounds = { x: 0, y: 0, width: 1920, height: 1080 }
      window.emit('resize')
      await controller.stop()
      expect(update).toHaveBeenLastCalledWith({
        mainWindowState: { bounds: normal, maximized: false },
      })
    }
  )

  test('logs failed background writes and retries the final state on shutdown', async () => {
    const { controller, start, update, onError } = fixture()
    const error = new Error('disk unavailable')
    update.mockRejectedValueOnce(error)
    start()
    await vi.runAllTimersAsync()
    expect(onError).toHaveBeenCalledWith(error)
    await controller.stop()
    expect(update).toHaveBeenCalledTimes(2)
  })

  test('flushes the last captured bounds after native destruction', async () => {
    const { controller, window, start, update } = fixture()
    start()
    window.bounds.width = 980
    window.emit('resize')
    window.destroyed = true
    window.emit('closed')
    await controller.stop()
    expect(update).toHaveBeenCalledWith({
      mainWindowState: { bounds: window.bounds, maximized: false },
    })
    expect(window.listenerCount('resize')).toBe(0)
  })

  test('restores geometry from real persisted preferences without overwriting other settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-window-state-'))
    roots.push(root)
    const store = new PreferencesStore(root)
    await store.update({ appearanceMode: 'light' })
    const window = new FakeWindow()
    const controller = new MainWindowStateController(store, error => {
      throw error
    })
    controller.start(window as Parameters<typeof controller.start>[0])
    window.bounds = { x: 150, y: 90, width: 1050, height: 680 }
    window.maximized = true
    await controller.stop()
    await store.close()
    const restored = await new PreferencesStore(root).read()
    expect(restored.appearanceMode).toBe('light')
    expect(
      startupWindowLayout({ x: 0, y: 0, width: 1920, height: 1080 }, restored.mainWindowState)
    ).toEqual({ bounds: window.bounds, maximized: true })
  })
})
