import type { BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import {
  maximizeStartupWindow,
  prepareStartupMainWindow,
  type StartupWindowDisplays,
  type StartupWindowHandoffTrace,
} from './startup-window-handoff.js'

function fixture() {
  const calls: string[] = []
  const bounds = { x: 120, y: 80, width: 1200, height: 800 }
  const nativeEvents = new EventEmitter()
  let mainBounds = { ...bounds }
  let visible = false
  let maximized = false
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
    isMaximized: () => maximized,
    isMinimized: () => false,
    isVisible: () => visible,
    maximize: vi.fn(() => {
      calls.push('maximize')
      visible = true
      maximized = true
      nativeEvents.emit('maximize')
    }),
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
  const prepare = (
    show = true,
    onTrace?: (event: StartupWindowHandoffTrace) => void,
    displays: StartupWindowDisplays = { main: 1, splash: 1 },
    shouldContinue?: () => boolean
  ) =>
    prepareStartupMainWindow(
      main as unknown as BrowserWindow,
      splash as unknown as BrowserWindow,
      show,
      displays,
      onTrace,
      shouldContinue
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
    setMaximized: (value: boolean) => {
      maximized = value
    },
  }
}

describe('preparing the native startup destination', () => {
  test('cancels pending maximization without restacking or capturing the fallback window', async () => {
    vi.useFakeTimers()
    const { prepare, main, splash, nativeEvents } = fixture()
    splash.isMaximized = () => true
    main.maximize.mockImplementation(() => {})
    let active = true
    try {
      const pending = prepare(true, undefined, undefined, () => active)
      const cancelled = expect(pending).rejects.toThrow('preparation was cancelled')
      expect(main.maximize).toHaveBeenCalledOnce()
      active = false
      await vi.advanceTimersByTimeAsync(16)
      await cancelled
      expect(splash.moveAbove).not.toHaveBeenCalled()
      expect(main.webContents.capturePage).not.toHaveBeenCalled()
      expect(main.setOpacity).toHaveBeenLastCalledWith(1)
      for (const event of ['maximize', 'resize', 'move', 'closed']) {
        expect(nativeEvents.listenerCount(event)).toBe(0)
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test('does not touch a window after presentation has already taken over', async () => {
    const { prepare, main, splash, calls } = fixture()
    await expect(prepare(true, undefined, undefined, () => false)).rejects.toThrow('cancelled')
    expect(calls).toEqual([])
    expect(main.setBounds).not.toHaveBeenCalled()
    expect(splash.moveAbove).not.toHaveBeenCalled()
  })

  test('accepts the OS maximized frame for the initial splash without requiring work-area bounds', async () => {
    const { main, bounds, nativeEvents, setMainBounds } = fixture()
    const nativeBounds = { x: -8, y: -8, width: 1040, height: 736 }
    setMainBounds(nativeBounds)

    await maximizeStartupWindow(main as unknown as BrowserWindow)

    expect(main.isMaximized()).toBe(true)
    expect(main.getBounds()).toEqual(nativeBounds)
    expect(main.getBounds()).not.toEqual(bounds)
    expect(main.setBounds).not.toHaveBeenCalled()
    for (const event of ['maximize', 'resize', 'move', 'closed']) {
      expect(nativeEvents.listenerCount(event)).toBe(0)
    }
  })

  test('waits for native maximization when the initial splash already fills the work area', async () => {
    const { main, nativeEvents, setMaximized } = fixture()
    main.maximize.mockImplementationOnce(() => {})
    let completed = false
    const pending = maximizeStartupWindow(main as unknown as BrowserWindow).then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)

    setMaximized(true)
    nativeEvents.emit('maximize')
    await pending

    expect(completed).toBe(true)
    expect(main.maximize).toHaveBeenCalledOnce()
    expect(nativeEvents.listenerCount('maximize')).toBe(0)
  })

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

  test('aligns a normal destination that starts at different native bounds', async () => {
    const { prepare, main, calls, bounds, setMainBounds } = fixture()
    setMainBounds({ x: 0, y: 0, width: 1280, height: 720 })
    expect(await prepare()).toEqual({ main: bounds, splash: bounds })
    expect(main.setBounds).toHaveBeenCalledOnce()
    expect(calls.indexOf('show-inactive')).toBeLessThan(calls.indexOf('bounds'))
    expect(calls.indexOf('bounds')).toBeLessThan(calls.indexOf('painted'))
  })

  test('keeps controlled background startup hidden while still waiting for a painted frame', async () => {
    const { prepare, main, splash, calls } = fixture()
    splash.isMaximized = () => true
    await prepare(false)
    expect(main.showInactive).not.toHaveBeenCalled()
    expect(splash.moveAbove).not.toHaveBeenCalled()
    expect(main.maximize).not.toHaveBeenCalled()
    expect(calls).toEqual(['opacity:0', 'bounds', 'painted', 'opacity:1'])
  })

  test('preserves maximized startup geometry without taking focus', async () => {
    const { prepare, main, splash, calls } = fixture()
    splash.isMaximized = () => true
    await prepare()
    expect(main.maximize).toHaveBeenCalledOnce()
    expect(main.showInactive).toHaveBeenCalledOnce()
    expect(main.setBounds).not.toHaveBeenCalled()
    expect(calls).toEqual([
      'opacity:0',
      'show-inactive',
      'maximize',
      'splash-above',
      'painted',
      'opacity:1',
    ])
  })

  test.each(['state-first', 'geometry-first'])(
    'accepts the OS maximized frame without requiring splash geometry: %s',
    async order => {
      const { prepare, main, splash, bounds, nativeEvents, setMainBounds, setMaximized } = fixture()
      splash.isMaximized = () => true
      setMainBounds({ x: 0, y: 0, width: 1280, height: 720 })
      main.maximize.mockImplementationOnce(() => {})
      const preparing = prepare()
      expect(main.webContents.capturePage).not.toHaveBeenCalled()
      if (order === 'state-first') {
        setMaximized(true)
        nativeEvents.emit('maximize')
      } else {
        setMainBounds(bounds)
        nativeEvents.emit('resize')
      }
      setMainBounds(bounds)
      setMaximized(true)
      nativeEvents.emit(order === 'state-first' ? 'resize' : 'maximize')

      expect(await preparing).toEqual({ main: bounds, splash: bounds })
      expect(main.setBounds).not.toHaveBeenCalled()
      for (const event of ['maximize', 'resize', 'move', 'closed']) {
        expect(nativeEvents.listenerCount(event)).toBe(0)
      }
    }
  )

  test('preserves already maximized geometry when native presentation emits no new event', async () => {
    const { prepare, main, splash, bounds, setMaximized } = fixture()
    splash.isMaximized = () => true
    setMaximized(true)
    main.maximize.mockImplementationOnce(() => {})

    expect(await prepare()).toEqual({ main: bounds, splash: bounds })
    expect(main.maximize).toHaveBeenCalledOnce()
    expect(main.setBounds).not.toHaveBeenCalled()
  })

  test('observes exact maximized state settling after the last native window event', async () => {
    vi.useFakeTimers()
    try {
      const { prepare, main, splash, bounds, nativeEvents, setMainBounds, setMaximized } = fixture()
      splash.isMaximized = () => true
      setMainBounds({ ...bounds, x: bounds.x + 4 })
      main.maximize.mockImplementationOnce(() => {})
      const preparing = prepare()
      nativeEvents.emit('move')
      await vi.advanceTimersByTimeAsync(16)
      expect(main.webContents.capturePage).not.toHaveBeenCalled()

      setMainBounds(bounds)
      setMaximized(true)
      await vi.advanceTimersByTimeAsync(16)
      expect(await preparing).toEqual({ main: bounds, splash: bounds })
      expect(main.maximize).toHaveBeenCalledOnce()
      expect(main.hide).not.toHaveBeenCalled()
      expect(main.setBounds).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      for (const event of ['maximize', 'resize', 'move', 'closed']) {
        expect(nativeEvents.listenerCount(event)).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test('checks exact native state at the existing deadline before rejecting', async () => {
    vi.useFakeTimers()
    try {
      const { main, bounds, nativeEvents, setMaximized } = fixture()
      main.maximize.mockImplementationOnce(() => {})
      const pending = maximizeStartupWindow(main as unknown as BrowserWindow, bounds)
      await vi.advanceTimersByTimeAsync(4999)
      setMaximized(true)
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(main.maximize).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      for (const event of ['maximize', 'resize', 'move', 'closed']) {
        expect(nativeEvents.listenerCount(event)).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test.each([
    { phase: 'sampling', before: 0, remaining: 16 },
    { phase: 'deadline', before: 4999, remaining: 1 },
  ])(
    'rejects a native getter exception during $phase and cleans up',
    async ({ before, remaining }) => {
      vi.useFakeTimers()
      try {
        const { main, bounds, nativeEvents } = fixture()
        main.maximize.mockImplementationOnce(() => {})
        const failure = expect(
          maximizeStartupWindow(main as unknown as BrowserWindow, bounds)
        ).rejects.toThrow('Native geometry unavailable')
        await vi.advanceTimersByTimeAsync(before)
        main.getBounds = () => {
          throw new Error('Native geometry unavailable')
        }
        await vi.advanceTimersByTimeAsync(remaining)
        await failure
        expect(vi.getTimerCount()).toBe(0)
        for (const event of ['maximize', 'resize', 'move', 'closed']) {
          expect(nativeEvents.listenerCount(event)).toBe(0)
        }
      } finally {
        vi.useRealTimers()
      }
    }
  )

  test('requests native presentation even when a hidden maximized window already matches', async () => {
    const { main, bounds, setMaximized, nativeEvents } = fixture()
    setMaximized(true)
    expect(main.isVisible()).toBe(false)
    main.maximize.mockImplementationOnce(() => {
      main.showInactive()
    })

    await maximizeStartupWindow(main as unknown as BrowserWindow, bounds)
    expect(main.maximize).toHaveBeenCalledOnce()
    expect(main.isVisible()).toBe(true)
    for (const event of ['maximize', 'resize', 'move', 'closed']) {
      expect(nativeEvents.listenerCount(event)).toBe(0)
    }
  })

  test('keeps full-display maximized geometry out of the normal X11 bounds setter', async () => {
    const { prepare, main, splash, nativeEvents, setMainBounds, setMaximized } = fixture()
    const bounds = { x: 0, y: 0, width: 1280, height: 720 }
    splash.isMaximized = () => true
    splash.getBounds = () => bounds
    main.setBounds.mockImplementation(value => {
      setMainBounds({ ...value, width: value.width - 1, height: value.height - 1 })
    })
    main.maximize.mockImplementationOnce(() => {
      setMainBounds(bounds)
      setMaximized(true)
      nativeEvents.emit('maximize')
    })

    expect(await prepare()).toEqual({ main: bounds, splash: bounds })
    expect(main.setBounds).not.toHaveBeenCalled()
  })

  test('fits the source restore size onto its current display instead of its previous display', async () => {
    const { prepare, main, splash, calls, nativeEvents, setMainBounds, setMaximized } = fixture()
    const maximized = { x: -1920, y: 0, width: 1920, height: 1080 }
    const restored = { x: 240, y: 60, width: 1440, height: 960 }
    splash.isMaximized = () => true
    splash.getBounds = () => maximized
    splash.getNormalBounds = () => restored
    main.maximize.mockImplementationOnce(() => {
      calls.push('maximize')
      setMainBounds(maximized)
      setMaximized(true)
      nativeEvents.emit('maximize')
    })

    expect(await prepare(true, undefined, { main: 1, splash: 2 })).toEqual({
      main: maximized,
      splash: maximized,
    })
    expect(main.setBounds).toHaveBeenCalledExactlyOnceWith({
      x: -1680,
      y: 60,
      width: 1440,
      height: 960,
    })
    expect(calls.indexOf('bounds')).toBeLessThan(calls.indexOf('maximize'))
  })

  test('fits a larger restore size onto a smaller target display before native maximization', async () => {
    const { prepare, main, splash, nativeEvents, setMainBounds, setMaximized } = fixture()
    const target = { x: -640, y: -480, width: 640, height: 480 }
    splash.isMaximized = () => true
    splash.getBounds = () => target
    splash.getNormalBounds = () => ({ x: 240, y: 60, width: 1440, height: 960 })
    main.setBounds.mockImplementationOnce(value => {
      setMainBounds({ ...value, width: value.width - 1, height: value.height - 1 })
    })
    main.maximize.mockImplementationOnce(() => {
      setMainBounds(target)
      setMaximized(true)
      nativeEvents.emit('maximize')
    })

    expect(await prepare(true, undefined, { main: 1, splash: 2 })).toEqual({
      main: target,
      splash: target,
    })
    expect(main.setBounds).toHaveBeenCalledExactlyOnceWith(target)
  })

  test('presents the normal window when the OS refuses maximization', async () => {
    vi.useFakeTimers()
    try {
      const { prepare, main, splash, nativeEvents } = fixture()
      splash.isMaximized = () => true
      main.maximize.mockImplementationOnce(() => {})
      const preparing = prepare()
      await vi.runAllTimersAsync()
      await preparing
      expect(main.hide).not.toHaveBeenCalled()
      expect(main.isVisible()).toBe(true)
      expect(main.webContents.capturePage).toHaveBeenCalledOnce()
      for (const event of ['maximize', 'resize', 'move', 'closed']) {
        expect(nativeEvents.listenerCount(event)).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test('settles a destroyed destination while its native maximize request is pending', async () => {
    const { prepare, main, splash, nativeEvents } = fixture()
    splash.isMaximized = () => true
    main.maximize.mockImplementationOnce(() => {})
    const failure = expect(prepare()).rejects.toThrow('closed before maximizing')
    main.isDestroyed = () => true
    nativeEvents.emit('closed')
    await failure
    expect(main.webContents.capturePage).not.toHaveBeenCalled()
    for (const event of ['maximize', 'resize', 'move', 'closed']) {
      expect(nativeEvents.listenerCount(event)).toBe(0)
    }
  })

  test('keeps the normal window available after a synchronous maximize failure', async () => {
    const { prepare, main, splash, nativeEvents } = fixture()
    splash.isMaximized = () => true
    const error = new Error('Native maximize failed')
    main.maximize.mockImplementationOnce(() => {
      throw error
    })
    await prepare()
    expect(main.hide).not.toHaveBeenCalled()
    expect(main.isVisible()).toBe(true)
    for (const event of ['maximize', 'resize', 'move', 'closed']) {
      expect(nativeEvents.listenerCount(event)).toBe(0)
    }
  })

  test('keeps the destination visible when optional frame capture fails', async () => {
    const { prepare, main, calls } = fixture()
    main.webContents.capturePage.mockRejectedValueOnce(new Error('Renderer stopped'))
    await prepare()
    expect(main.hide).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('opacity:1')
    expect(main.isVisible()).toBe(true)
  })

  test('a hung frame capture restores the ready window after its own deadline', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { prepare, main } = fixture()
      main.webContents.capturePage.mockImplementationOnce(() => new Promise(() => {}))
      const pending = prepare()
      await vi.advanceTimersByTimeAsync(1500)
      await pending
      expect(main.setOpacity).toHaveBeenLastCalledWith(1)
      expect(main.isVisible()).toBe(true)
      expect(warning).toHaveBeenCalledWith(
        '[startup-window-handoff] could not capture the main window',
        expect.objectContaining({ message: 'Startup animation exceeded 1500ms' })
      )
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      warning.mockRestore()
      vi.useRealTimers()
    }
  })

  test('does not hide a loaded destination because frame capture is empty', async () => {
    const { prepare, main } = fixture()
    main.webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
    })
    await prepare()
    expect(main.hide).not.toHaveBeenCalled()
    expect(main.isVisible()).toBe(true)
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

  test('presents the window when both optional capture and diagnostic recording fail', async () => {
    const { prepare, main, nativeEvents } = fixture()
    const captureError = new Error('Renderer stopped')
    main.webContents.capturePage.mockRejectedValueOnce(captureError)
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const phases: string[] = []
    try {
      await prepare(true, event => {
        phases.push(event.phase)
        if (event.phase === 'capture-failed') throw new Error('Diagnostic sink stopped')
      })
      expect(phases).toContain('capture-failed')
      expect(phases).toContain('before-opacity-restore')
      expect(logError).toHaveBeenCalledWith(
        '[startup-window-handoff] Could not record native geometry',
        { phase: 'capture-failed', error: { name: 'Error', message: 'Diagnostic sink stopped' } }
      )
      expect(main.hide).not.toHaveBeenCalled()
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
