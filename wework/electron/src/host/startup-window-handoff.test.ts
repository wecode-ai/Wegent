import type { BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import {
  prepareStartupMainWindow,
  type StartupWindowHandoffTrace,
} from './startup-window-handoff.js'

function fixture(normalizeOnShow = false) {
  const calls: string[] = []
  const bounds = { x: 120, y: 80, width: 1200, height: 800 }
  const nativeEvents = new EventEmitter()
  let mainBounds = { ...bounds }
  let visible = false
  const main = {
    getBounds: () => ({ ...mainBounds }),
    getContentBounds: () => ({ ...mainBounds }),
    getContentSize: () => [mainBounds.width, mainBounds.height],
    getNormalBounds: () => ({ ...mainBounds }),
    getMediaSourceId: () => 'window:12:0',
    hide: vi.fn(() => {
      calls.push('hide')
      visible = false
    }),
    isDestroyed: () => false,
    isFocused: () => false,
    isMaximized: () => false,
    isMinimized: () => false,
    isVisible: () => visible,
    maximize: vi.fn(() => calls.push('maximize')),
    on: nativeEvents.on.bind(nativeEvents),
    removeListener: nativeEvents.removeListener.bind(nativeEvents),
    setBounds: vi.fn((value: typeof bounds) => {
      calls.push('bounds')
      mainBounds = { ...value }
    }),
    setOpacity: vi.fn((value: number) => calls.push(`opacity:${value}`)),
    showInactive: vi.fn(() => {
      calls.push('show-inactive')
      visible = true
      if (normalizeOnShow) {
        mainBounds = {
          ...mainBounds,
          width: mainBounds.width - 1,
          height: mainBounds.height - 1,
        }
      }
    }),
    webContents: {
      getZoomFactor: () => 1.25,
      isDestroyed: () => false,
      capturePage: vi.fn(async () => {
        calls.push('painted')
        return {
          isEmpty: () => false,
          getSize: () => ({ width: mainBounds.width, height: mainBounds.height }),
        }
      }),
    },
  }
  const splash = {
    getBounds: () => bounds,
    getContentBounds: () => ({ ...bounds }),
    getContentSize: () => [bounds.width, bounds.height],
    getNormalBounds: () => ({ ...bounds }),
    isDestroyed: () => false,
    isFocused: () => true,
    isMaximized: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    moveAbove: vi.fn(() => calls.push('splash-above')),
    webContents: { getZoomFactor: () => 1, isDestroyed: () => false },
  }
  const prepare = (show = true, onTrace?: (event: StartupWindowHandoffTrace) => void) =>
    prepareStartupMainWindow(
      main as unknown as BrowserWindow,
      splash as unknown as BrowserWindow,
      show,
      onTrace
    )
  return {
    prepare,
    main,
    splash,
    calls,
    bounds,
    nativeEvents,
    setMainBounds: (value: typeof bounds) => {
      mainBounds = { ...value }
    },
  }
}

describe('preparing the native startup destination', () => {
  test('aligns geometry and native stacking, then exposes a painted main behind the splash', async () => {
    const { prepare, main, splash, calls, bounds } = fixture()
    expect(await prepare()).toEqual({ main: bounds, splash: bounds })
    expect(main.setBounds).toHaveBeenCalledWith(bounds)
    expect(splash.moveAbove).toHaveBeenCalledWith('window:12:0')
    expect(calls).toEqual([
      'opacity:0',
      'show-inactive',
      'bounds',
      'splash-above',
      'painted',
      'opacity:1',
    ])
    expect(main.maximize).not.toHaveBeenCalled()
  })

  test('aligns the mapped main window after native first-show geometry normalization', async () => {
    const { prepare, main, calls, bounds } = fixture(true)
    expect(await prepare()).toEqual({ main: bounds, splash: bounds })
    expect(main.setBounds).toHaveBeenCalledOnce()
    expect(calls.indexOf('show-inactive')).toBeLessThan(calls.indexOf('bounds'))
    expect(calls.indexOf('bounds')).toBeLessThan(calls.indexOf('painted'))
  })

  test('keeps controlled background startup hidden while still waiting for a painted frame', async () => {
    const { prepare, main, splash, calls } = fixture()
    await prepare(false)
    expect(main.showInactive).not.toHaveBeenCalled()
    expect(splash.moveAbove).not.toHaveBeenCalled()
    expect(calls).toEqual(['opacity:0', 'bounds', 'painted', 'opacity:1'])
  })

  test('preserves maximized startup geometry without taking focus', async () => {
    const { prepare, main, splash, calls } = fixture()
    splash.isMaximized = () => true
    await prepare()
    expect(main.maximize).toHaveBeenCalledOnce()
    expect(main.showInactive).toHaveBeenCalledOnce()
    expect(calls).toEqual([
      'opacity:0',
      'show-inactive',
      'bounds',
      'maximize',
      'splash-above',
      'painted',
      'opacity:1',
    ])
  })

  test('hides a failed destination and restores its opacity before propagating failure', async () => {
    const { prepare, main, calls } = fixture()
    main.webContents.capturePage.mockRejectedValueOnce(new Error('Renderer stopped'))
    await expect(prepare()).rejects.toThrow('Renderer stopped')
    expect(calls.slice(-2)).toEqual(['hide', 'opacity:1'])
  })

  test('refuses to expose a destination with no composited frame', async () => {
    const { prepare, main } = fixture()
    main.webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
    })
    await expect(prepare()).rejects.toThrow('did not produce a frame')
    expect(main.hide).toHaveBeenCalledOnce()
    expect(main.setOpacity).toHaveBeenLastCalledWith(1)
  })

  test('traces late native geometry without correcting it and removes its listeners', async () => {
    const { prepare, main, bounds, nativeEvents, setMainBounds } = fixture()
    const normalized = { ...bounds, width: bounds.width - 1, height: bounds.height - 1 }
    const traces: StartupWindowHandoffTrace[] = []
    main.webContents.capturePage.mockImplementationOnce(async () => {
      setMainBounds(normalized)
      nativeEvents.emit('resize')
      nativeEvents.emit('move')
      return {
        isEmpty: () => false,
        getSize: () => ({ width: normalized.width, height: normalized.height }),
      }
    })

    expect(await prepare(true, event => traces.push(event))).toEqual({
      splash: bounds,
      main: normalized,
    })
    expect(traces.map(event => event.phase)).toEqual([
      'before-map',
      'after-opacity-hide',
      'before-show',
      'after-show',
      'before-set-bounds',
      'after-set-bounds',
      'before-stack',
      'after-stack',
      'before-capture',
      'native-resize',
      'native-move',
      'after-capture',
      'before-opacity-restore',
      'after-opacity-restore',
    ])
    expect(traces.find(event => event.phase === 'after-set-bounds')?.main?.bounds).toEqual(bounds)
    expect(traces.find(event => event.phase === 'after-capture')).toMatchObject({
      requestedBounds: bounds,
      main: {
        bounds: normalized,
        contentBounds: normalized,
        normalBounds: normalized,
        contentSize: { width: normalized.width, height: normalized.height },
        zoomFactor: 1.25,
        visible: true,
        focused: false,
        minimized: false,
        maximized: false,
      },
      splash: { bounds, zoomFactor: 1, focused: true },
      nativeEvents: { observed: 2, omitted: 0 },
      capturedFrameSize: { width: normalized.width, height: normalized.height },
    })
    expect(main.setBounds).toHaveBeenCalledOnce()
    expect(nativeEvents.listenerCount('resize')).toBe(0)
    expect(nativeEvents.listenerCount('move')).toBe(0)
    const count = traces.length
    nativeEvents.emit('resize')
    expect(traces).toHaveLength(count)
  })

  test('retains the original capture failure when diagnostic recording also fails', async () => {
    const { prepare, main, nativeEvents } = fixture()
    const captureError = new Error('Renderer stopped')
    main.webContents.capturePage.mockRejectedValueOnce(captureError)
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const phases: string[] = []
    try {
      await expect(
        prepare(true, event => {
          phases.push(event.phase)
          if (event.phase === 'capture-failed') throw new Error('Diagnostic sink stopped')
        })
      ).rejects.toBe(captureError)
      expect(phases).toContain('capture-failed')
      expect(phases).toContain('before-opacity-restore')
      expect(logError).toHaveBeenCalledWith(
        '[startup-window-handoff] Could not record native geometry',
        { phase: 'capture-failed', error: { name: 'Error', message: 'Diagnostic sink stopped' } }
      )
      expect(main.hide).toHaveBeenCalledOnce()
      expect(main.setOpacity).toHaveBeenLastCalledWith(1)
      expect(nativeEvents.listenerCount('resize')).toBe(0)
      expect(nativeEvents.listenerCount('move')).toBe(0)
    } finally {
      logError.mockRestore()
    }
  })

  test('bounds native-event logs while reporting omitted events at completion', async () => {
    const { prepare, main, nativeEvents } = fixture()
    const traces: StartupWindowHandoffTrace[] = []
    main.webContents.capturePage.mockImplementationOnce(async () => {
      for (let index = 0; index < 40; index++) nativeEvents.emit('resize')
      return { isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }) }
    })
    await prepare(true, event => traces.push(event))
    expect(traces.filter(event => event.phase === 'native-resize')).toHaveLength(32)
    expect(traces.at(-1)?.nativeEvents).toEqual({ observed: 40, omitted: 8 })
    expect(nativeEvents.listenerCount('resize')).toBe(0)
  })

  test('reports capture-size diagnostic failures without changing successful presentation', async () => {
    const { prepare, main, bounds, nativeEvents } = fixture()
    const sizeError = new Error('Frame size is unavailable')
    main.webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      getSize: () => {
        throw sizeError
      },
    })
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await prepare(true, vi.fn())).toEqual({ main: bounds, splash: bounds })
      expect(logError).toHaveBeenCalledWith(
        '[startup-window-handoff] Could not record native geometry',
        { phase: 'after-capture', error: { name: 'Error', message: sizeError.message } }
      )
      expect(main.hide).not.toHaveBeenCalled()
      expect(main.setOpacity).toHaveBeenLastCalledWith(1)
      expect(nativeEvents.listenerCount('resize')).toBe(0)
      expect(nativeEvents.listenerCount('move')).toBe(0)
    } finally {
      logError.mockRestore()
    }
  })
})
