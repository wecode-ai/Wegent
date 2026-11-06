import { describe, expect, test, vi } from 'vitest'
import {
  createStartupReadyHandler,
  createStartupSplash,
  resolveStartupSplashHoldMs,
  resolveStartupSplashTheme,
  startupSplashBlocksMainWindowActivation,
  type StartupSplashSnapshot,
  type StartupSplashTheme,
  type StartupSplashWindow,
} from './startup-splash.js'
import { STARTUP_PROGRESS_CHANNEL } from './startup-progress.js'

describe('startup readiness notifications', () => {
  test('presents the main window only once across concurrent and later notifications', async () => {
    const presentMainWindow = vi.fn(async () => {})
    const ready = createStartupReadyHandler<string>(presentMainWindow)
    await Promise.all([ready('task-list'), ready('other')])
    await ready('task-list')
    expect(presentMainWindow).toHaveBeenCalledExactlyOnceWith('task-list')
  })

  test('allows startup completion after a failed attempt', async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('close failed'))
      .mockResolvedValue(undefined)
    const ready = createStartupReadyHandler(complete)
    await expect(ready('task-list')).rejects.toThrow('close failed')
    await ready('task-list')
    expect(complete).toHaveBeenCalledTimes(2)
  })

  test('holds activation before window creation and while the splash is loading', async () => {
    const ready = createStartupReadyHandler(async () => {
      await fixture.splash.close()
    })
    const activated = vi.fn()
    const pending = ready.whenReady.then(activated)
    await Promise.resolve()
    expect(activated).not.toHaveBeenCalled()
    const fixture = createFixture()
    const showing = fixture.show()
    expect(fixture.splash.snapshot().state).toBe('loading')
    await Promise.resolve()
    expect(activated).not.toHaveBeenCalled()
    await showing
    expect(fixture.target.requestNativeClose()).toBe(false)
    expect(activated).not.toHaveBeenCalled()
    await ready('task-list')
    await pending
    expect(fixture.splash.snapshot().state).toBe('closed')
    expect(activated).toHaveBeenCalledOnce()
  })

  test('releases startup waiters immediately when shutdown cancels startup', async () => {
    const complete = vi.fn(async () => {})
    const ready = createStartupReadyHandler(complete)
    const released = vi.fn()
    const pending = ready.whenReady.then(released)
    ready.cancel()
    await pending
    expect(released).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
  })
})

class FakeSplashWindow implements StartupSplashWindow {
  private readonly closeListeners: Array<(event: { preventDefault: () => void }) => void> = []
  private readonly closedListeners: Array<() => void> = []
  private destroyed = false
  private visible = false

  readonly close = vi.fn(() => {
    const event = { preventDefault: vi.fn() }
    this.closeListeners.forEach(listener => listener(event))
    if (event.preventDefault.mock.calls.length > 0) return
    this.destroyed = true
    this.visible = false
    this.closedListeners.forEach(listener => listener())
  })
  readonly isDestroyed = vi.fn(() => this.destroyed)
  readonly isVisible = vi.fn(() => this.visible)
  readonly show = vi.fn(() => {
    this.visible = true
  })
  readonly setOpacity = vi.fn()
  readonly webContents = {
    capturePage: vi.fn(async () => ({
      toPNG: () => Buffer.from('splash-png'),
    })),
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  }

  on(event: 'close', listener: (event: { preventDefault: () => void }) => void): void {
    if (event === 'close') this.closeListeners.push(listener)
  }

  once(event: 'closed', listener: () => void): void {
    if (event === 'closed') this.closedListeners.push(listener)
  }

  requestNativeClose(): boolean {
    const event = { preventDefault: vi.fn() }
    this.closeListeners.forEach(listener => listener(event))
    if (event.preventDefault.mock.calls.length > 0) return false
    this.destroyed = true
    this.visible = false
    this.closedListeners.forEach(listener => listener())
    return true
  }
}

function createFixture(theme: StartupSplashTheme = 'light', onCloseRequest?: () => void) {
  const target = new FakeSplashWindow()
  const writePng = vi.fn(async () => undefined)
  let timestamp = 100
  const splash = createStartupSplash({
    window: target,
    theme,
    now: () => timestamp++,
    writePng,
    onCloseRequest,
  })
  const show = () => splash.show()
  return { show, splash, target, writePng }
}

describe('StartupSplash', () => {
  test('shows the branded animation in the main startup window and records its timeline', async () => {
    const { show, target } = createFixture()

    const snapshot = await show()

    expect(target.show).toHaveBeenCalledOnce()
    expect(target.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('dataset.animationReady')
    )
    expect(snapshot).toEqual({
      state: 'visible',
      theme: 'light',
      events: [
        { name: 'created', timestamp: 100 },
        { name: 'animation-ready', timestamp: 101 },
        { name: 'shown', timestamp: 102 },
      ],
      window: {
        exists: true,
        destroyed: false,
        visible: true,
      },
    })
  })

  test('retains the saved dark appearance in the embedded splash snapshot', async () => {
    const { show } = createFixture('dark')

    const snapshot = await show()

    expect(snapshot.theme).toBe('dark')
  })

  test('waits for native presentation before marking the splash visible', async () => {
    const { show, splash, target } = createFixture()
    let finishPresentation!: () => void
    const presentation = new Promise<void>(resolve => {
      finishPresentation = resolve
    })
    let presentationStarted!: () => void
    const started = new Promise<void>(resolve => {
      presentationStarted = resolve
    })
    const originalShow = target.show.getMockImplementation()!
    target.show.mockImplementationOnce(async () => {
      originalShow()
      presentationStarted()
      await presentation
    })
    const showing = show()
    await started
    expect(splash.snapshot().state).toBe('loading')
    expect(splash.snapshot().events.map(event => event.name)).toEqual([
      'created',
      'animation-ready',
    ])
    finishPresentation()
    expect((await showing).state).toBe('visible')
    expect(splash.snapshot().events.at(-1)?.name).toBe('shown')
  })

  test('propagates native presentation failure without reporting a shown splash', async () => {
    const { show, splash, target } = createFixture()
    const error = new Error('Native maximize failed')
    target.show.mockImplementationOnce(async () => {
      throw error
    })
    await expect(show()).rejects.toBe(error)
    expect(splash.snapshot().events.map(event => event.name)).toEqual([
      'created',
      'animation-ready',
    ])
  })

  test('keeps a closed splash closed when pending native presentation finishes', async () => {
    const { show, splash, target } = createFixture()
    let finishPresentation!: () => void
    const presentation = new Promise<void>(resolve => {
      finishPresentation = resolve
    })
    let presentationStarted!: () => void
    const started = new Promise<void>(resolve => {
      presentationStarted = resolve
    })
    target.show.mockImplementationOnce(async () => {
      presentationStarted()
      await presentation
    })
    const showing = show()
    await started
    await splash.close()
    finishPresentation()
    expect((await showing).state).toBe('closed')
    expect(splash.snapshot().events.map(event => event.name)).toEqual([
      'created',
      'animation-ready',
      'closed',
    ])
  })

  test('replays the latest startup stage once the splash is visible', async () => {
    const { show, splash, target } = createFixture()
    const update = {
      index: 2,
      total: 9,
      completedWeight: 10,
      startedAt: 1_000,
      stage: {
        id: 'components',
        label: { en: 'Checking local components', zh: '检查本地组件' },
        detail: { en: 'Scanning local component files…', zh: '正在扫描本地组件文件…' },
        weight: 15,
        expectedMs: 2_500,
        timeoutMs: 60_000,
      },
    }

    splash.updateProgress(update)
    expect(target.webContents.send).not.toHaveBeenCalled()

    await show()

    expect(target.webContents.send).toHaveBeenCalledOnce()
    expect(target.webContents.send).toHaveBeenCalledWith(STARTUP_PROGRESS_CHANNEL, update)
  })

  test('mirrors later startup stages while the splash is visible', async () => {
    const { show, splash, target } = createFixture()
    await show()
    target.webContents.send.mockClear()
    const update = {
      index: 3,
      total: 9,
      completedWeight: 25,
      startedAt: 2_000,
      stage: {
        id: 'runtime-files',
        label: { en: 'Preparing the runtime', zh: '准备运行环境' },
        detail: { en: 'Verifying and unpacking runtime files…', zh: '正在校验并解压运行环境…' },
        weight: 15,
        expectedMs: 4_000,
        timeoutMs: 120_000,
      },
    }

    splash.updateProgress(update)

    expect(target.webContents.send).toHaveBeenCalledWith(STARTUP_PROGRESS_CHANNEL, update)
  })

  test('notifies the splash renderer when startup fails', async () => {
    const { show, splash, target } = createFixture()
    await show()

    await splash.showError()

    expect(target.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('wework-startup-error')
    )
  })

  test('includes the failed plugin in the startup error event', async () => {
    const { show, splash, target } = createFixture()
    await show()

    await splash.showError('@wegent/ai-fleet-defense')

    expect(target.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"@wegent/ai-fleet-defense"')
    )
  })

  test('resolves explicit appearance modes before falling back to the system theme', () => {
    expect(resolveStartupSplashTheme('light', true)).toBe('light')
    expect(resolveStartupSplashTheme('dark', false)).toBe('dark')
    expect(resolveStartupSplashTheme('system', true)).toBe('dark')
    expect(resolveStartupSplashTheme('system', false)).toBe('light')
    expect(resolveStartupSplashTheme(undefined, true)).toBe('dark')
  })

  test('holds the splash only for the desktop E2E harness', () => {
    const hold = (environment: NodeJS.ProcessEnv) =>
      resolveStartupSplashHoldMs({ VITE_WEWORK_E2E: 'true', ...environment })

    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '5000' })).toBe(5000)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '' })).toBe(0)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '0' })).toBe(0)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '-1' })).toBe(0)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: 'not-a-number' })).toBe(0)
    expect(hold({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '999999' })).toBe(120_000)
    expect(resolveStartupSplashHoldMs({ WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '5000' })).toBe(0)
  })

  test('blocks main-window activation until the startup splash closes', () => {
    const snapshot = (state: StartupSplashSnapshot['state']): StartupSplashSnapshot => ({
      state,
      theme: 'light',
      events: [],
      window: {
        exists: true,
        destroyed: state === 'closed',
        visible: state === 'visible',
      },
    })

    expect(startupSplashBlocksMainWindowActivation(null)).toBe(false)
    expect(startupSplashBlocksMainWindowActivation(snapshot('idle'))).toBe(true)
    expect(startupSplashBlocksMainWindowActivation(snapshot('loading'))).toBe(true)
    expect(startupSplashBlocksMainWindowActivation(snapshot('visible'))).toBe(true)
    expect(startupSplashBlocksMainWindowActivation(snapshot('closed'))).toBe(false)
  })

  test('does not capture or write files during a production close', async () => {
    const { show, splash, target, writePng } = createFixture()
    await show()

    const snapshot = await splash.close()

    expect(target.webContents.capturePage).not.toHaveBeenCalled()
    expect(writePng).not.toHaveBeenCalled()
    expect(target.close).toHaveBeenCalledOnce()
    expect(snapshot.state).toBe('closed')
    expect(snapshot.events.at(-1)).toEqual({ name: 'closed', timestamp: 103 })
    expect(snapshot.window).toEqual({
      exists: true,
      destroyed: true,
      visible: false,
    })
  })

  test('prevents native close requests until renderer startup readiness closes it', async () => {
    const { show, splash, target } = createFixture()
    await show()

    expect(target.requestNativeClose()).toBe(false)
    expect(splash.snapshot().state).toBe('visible')
    expect(target.isDestroyed()).toBe(false)

    await splash.close()

    expect(target.close).toHaveBeenCalledOnce()
    expect(splash.snapshot().state).toBe('closed')
    expect(target.isDestroyed()).toBe(true)
  })

  test('reports refused native close requests so the host can decide what closing means', async () => {
    const onCloseRequest = vi.fn()
    const { show, splash, target } = createFixture('light', onCloseRequest)
    await show()

    expect(target.requestNativeClose()).toBe(false)
    expect(onCloseRequest).toHaveBeenCalledOnce()
    expect(splash.snapshot().state).toBe('visible')

    await splash.close()

    expect(onCloseRequest).toHaveBeenCalledOnce()
    expect(splash.snapshot().state).toBe('closed')
    expect(target.isDestroyed()).toBe(true)
  })

  test('captures and persists the rendered splash before closing when requested by E2E', async () => {
    const { show, splash, target, writePng } = createFixture()
    await show()

    await splash.close({ capturePath: '/tmp/wework-e2e/startup-splash.png' })
    await splash.close({ capturePath: '/tmp/wework-e2e/startup-splash-second.png' })

    expect(target.webContents.capturePage).toHaveBeenCalledOnce()
    expect(writePng).toHaveBeenCalledWith(
      '/tmp/wework-e2e/startup-splash.png',
      Buffer.from('splash-png')
    )
    expect(writePng).toHaveBeenCalledOnce()
    expect(target.close).toHaveBeenCalledOnce()
  })

  test('shares one close operation across concurrent callers', async () => {
    const { show, splash, target, writePng } = createFixture()
    await show()
    let finishCapture: (() => void) | undefined
    target.webContents.capturePage.mockImplementation(
      () =>
        new Promise(resolve => {
          finishCapture = () => resolve({ toPNG: () => Buffer.from('splash-png') })
        })
    )

    const first = splash.close({ capturePath: '/tmp/wework-e2e/startup-splash.png' })
    const second = splash.close({ capturePath: '/tmp/wework-e2e/startup-splash-second.png' })
    finishCapture?.()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(target.webContents.capturePage).toHaveBeenCalledOnce()
    expect(writePng).toHaveBeenCalledOnce()
    expect(writePng).toHaveBeenCalledWith(
      '/tmp/wework-e2e/startup-splash.png',
      Buffer.from('splash-png')
    )
  })

  test('shows the main startup window only once when show is called concurrently', async () => {
    const { splash, target } = createFixture()

    const firstPromise = splash.show()
    const secondPromise = splash.show()
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(target.show).toHaveBeenCalledOnce()
    expect(first).toEqual(second)
  })
})
