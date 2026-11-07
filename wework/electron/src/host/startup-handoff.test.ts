import { afterEach, describe, expect, test, vi } from 'vitest'
import { StartupProgressReporter } from './startup-progress.js'
import {
  createStartupSplash,
  createStartupReadyHandler,
  STARTUP_SPLASH_FADE_MS,
  type StartupSplashCompletion,
  type StartupSplashWindow,
} from './startup-splash.js'

afterEach(() => vi.useRealTimers())

const bounds = { x: 80, y: 100, width: 1440, height: 960 }
const completion: StartupSplashCompletion = {
  reducedMotion: false,
  progressNow: 100,
  fillEnd: 1359,
  trackEnd: 1359,
  wordmarkVisible: false,
  appearance: {
    theme: 'dark',
    colorScheme: 'dark',
    background: 'rgb(5, 7, 13)',
    footerBackground: 'rgb(5, 7, 13)',
  },
  canvas: { x: 0, y: 0, width: 1440, height: 960 },
  viewport: { width: 1440, height: 960 },
}

async function fixture() {
  vi.useFakeTimers()
  const closed: Array<() => void> = []
  let destroyed = false
  let release!: (value: StartupSplashCompletion) => void
  const complete = new Promise<StartupSplashCompletion>(resolve => {
    release = resolve
  })
  const target: StartupSplashWindow = {
    close: vi.fn(() => {
      destroyed = true
      closed.forEach(listener => listener())
    }),
    isDestroyed: () => destroyed,
    isVisible: () => !destroyed,
    on: vi.fn(),
    once: (_event, listener) => {
      closed.push(listener)
    },
    show: vi.fn(),
    setOpacity: vi.fn(),
    webContents: {
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('complete-frame') })),
      executeJavaScript: vi.fn(code =>
        code.includes('weworkStartupSplash.complete') ? complete : Promise.resolve(true)
      ),
      isDestroyed: () => destroyed,
      send: vi.fn(),
    },
  }
  const splash = createStartupSplash({ window: target, theme: 'dark' })
  await splash.show()
  const reporter = new StartupProgressReporter(vi.fn())
  reporter.report('renderer')
  const prepareMainWindow = vi.fn(async () => ({ splash: bounds, main: bounds }))
  let allowed = true
  const options = { update: reporter.complete(), prepareMainWindow, shouldContinue: () => allowed }
  return {
    splash,
    target,
    options,
    release,
    stop: () => {
      allowed = false
    },
  }
}

describe('startup window handoff', () => {
  test('keeps queued activation pending after failed startup until explicit shutdown cancellation', async () => {
    const ready = createStartupReadyHandler(async () => {
      throw new Error('Startup handoff failed')
    })
    const activated = vi.fn()
    const waiting = ready.whenReady.then(activated)
    await expect(ready('task-list')).rejects.toThrow('Startup handoff failed')
    await Promise.resolve()
    expect(activated).not.toHaveBeenCalled()
    ready.cancel()
    await waiting
    expect(activated).toHaveBeenCalledOnce()
  })
  test('waits for the complete frame, prepares the main behind it, then fades for 600ms', async () => {
    const { splash, target, options, release } = await fixture()
    const handoff = splash.handoff(options)
    expect(splash.handoff(options)).toBe(handoff)
    expect(splash.snapshot().state).toBe('completing')
    expect(options.prepareMainWindow).not.toHaveBeenCalled()
    expect(target.setOpacity).not.toHaveBeenCalled()
    release(completion)
    await vi.advanceTimersByTimeAsync(0)
    expect(options.prepareMainWindow).toHaveBeenCalledOnce()
    expect(splash.snapshot().state).toBe('fading')
    await vi.advanceTimersByTimeAsync(300)
    const midOpacity = vi.mocked(target.setOpacity).mock.lastCall?.[0] ?? -1
    expect(midOpacity).toBeGreaterThan(0.45)
    expect(midOpacity).toBeLessThan(0.55)
    expect(target.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(STARTUP_SPLASH_FADE_MS - 300)
    const snapshot = await handoff
    expect(snapshot.state).toBe('closed')
    expect(target.setOpacity).toHaveBeenLastCalledWith(0)
    expect(target.close).toHaveBeenCalledOnce()
    expect(snapshot.events.map(event => event.name)).toEqual([
      'created',
      'animation-ready',
      'shown',
      'completion-started',
      'completed',
      'main-prepared',
      'fade-started',
      'fade-completed',
      'closed',
    ])
    const timestamp = (name: string) =>
      snapshot.events.find(event => event.name === name)!.timestamp
    expect(timestamp('fade-completed') - timestamp('fade-started')).toBe(600)
    expect(snapshot.handoff).toEqual({
      completion,
      reducedMotion: false,
      fadeDurationMs: 600,
      bounds: { main: bounds, splash: bounds },
    })
    snapshot.handoff!.completion.progressNow = 0
    expect(splash.snapshot().handoff?.completion.progressNow).toBe(100)
  })

  test('honors reduced motion with a complete frame and no timed native fade', async () => {
    const { splash, target, options, release } = await fixture()
    const pending = splash.handoff(options)
    release({ ...completion, reducedMotion: true })
    expect((await pending).state).toBe('closed')
    expect(target.setOpacity).toHaveBeenCalledExactlyOnceWith(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('opens the ready main window even when decorative progress geometry is incomplete', async () => {
    const { splash, target, options, release } = await fixture()
    const pending = splash.handoff(options)
    release({ ...completion, fillEnd: 1000 })
    await vi.runAllTimersAsync()
    await pending
    expect(options.prepareMainWindow).toHaveBeenCalledOnce()
    expect(target.close).toHaveBeenCalledOnce()
    expect(splash.snapshot().state).toBe('closed')
  })

  test('does not reveal the main window when shutdown interrupts completion', async () => {
    const { splash, target, options, release, stop } = await fixture()
    const pending = splash.handoff(options)
    stop()
    release(completion)
    expect((await pending).state).toBe('visible')
    expect(options.prepareMainWindow).not.toHaveBeenCalled()
    expect(target.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('restores the splash and stops fading when a startup failure arrives', async () => {
    const { splash, target, options, release } = await fixture()
    const pending = splash.handoff(options)
    release(completion)
    await vi.advanceTimersByTimeAsync(200)
    await splash.showError()
    expect(target.setOpacity).toHaveBeenLastCalledWith(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await pending).state).toBe('visible')
    expect(target.close).not.toHaveBeenCalled()
    expect(splash.snapshot().events.some(event => event.name === 'fade-completed')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('allows shutdown to close immediately during the native fade', async () => {
    const { splash, target, options, release } = await fixture()
    const pending = splash.handoff(options)
    release(completion)
    await vi.advanceTimersByTimeAsync(200)
    await splash.close()
    await vi.advanceTimersByTimeAsync(16)
    expect((await pending).state).toBe('closed')
    expect(target.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('propagates main presentation failures without closing the startup recovery surface', async () => {
    const { splash, target, options, release } = await fixture()
    options.prepareMainWindow.mockRejectedValueOnce(new Error('Native window ordering failed'))
    const pending = splash.handoff(options)
    release(completion)
    await expect(pending).rejects.toThrow('Native window ordering failed')
    expect(target.setOpacity).toHaveBeenLastCalledWith(1)
    expect(target.close).not.toHaveBeenCalled()
    expect(splash.snapshot().state).toBe('visible')
  })
})
