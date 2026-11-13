import type { BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  observeStartupSplash,
  inspectStartupSplash,
  type StartupSplashInspection,
} from './startup-splash-verification.js'

afterEach(() => vi.useRealTimers())

describe('native startup splash observations', () => {
  test('keeps the rendered stage with its timeout state while the host advances', async () => {
    const renderedProgress = { stage: { id: 'core-dsh' }, startedAt: 100 }
    const context = {
      currentUpdate: renderedProgress,
      structuredClone,
      document: {
        getElementById: (id: string) => (id === 'startup-timeout' ? { hidden: false } : undefined),
        querySelectorAll: () => [],
      },
    }
    let release: () => void = () => {}
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const window = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async (script: string) => {
          const snapshot = runInNewContext(script, context)
          await pending
          return snapshot
        },
      },
    }
    const inspection = inspectStartupSplash(window as unknown as BrowserWindow)
    context.currentUpdate = { stage: { id: 'renderer' }, startedAt: 200 }
    release()
    expect(await inspection).toMatchObject({
      progress: renderedProgress,
      timeoutHidden: false,
    })
  })

  test('inspects real drag registration and excludes hidden controls from its geometry', async () => {
    const element = (id: string, appRegion: string, visible = true) => ({
      id,
      appRegion,
      checkVisibility: () => visible,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 1440, height: 600 }),
    })
    const stage = element('startup-window-drag-region', 'drag')
    const status = element('startup-status', 'no-drag')
    const retry = element('startup-retry', 'no-drag')
    const hidden = element('startup-confirmation-submit', 'no-drag', false)
    const window = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async (script: string) =>
          runInNewContext(script, {
            currentUpdate: null,
            structuredClone,
            getComputedStyle: (target: typeof stage) => ({
              getPropertyValue: () => target.appRegion,
            }),
            document: {
              getElementById: (id: string) =>
                [stage, status].find(candidate => candidate.id === id),
              querySelectorAll: () => [retry, hidden],
            },
          }),
      },
    }
    const snapshot = await inspectStartupSplash(window as unknown as BrowserWindow)
    expect(snapshot.dragRegions).toEqual({
      stage: expect.objectContaining({ id: stage.id, appRegion: 'drag' }),
      status: expect.objectContaining({ id: status.id, appRegion: 'no-drag' }),
      controls: [expect.objectContaining({ id: retry.id, appRegion: 'no-drag' })],
    })
  })

  test('reports rendered startup brand bounds and toast operation sequence', async () => {
    const brandBounds = {
      bottom: 480,
      height: 160,
      left: 100,
      right: 500,
      top: 320,
      width: 400,
    }
    const window = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async (script: string) =>
          runInNewContext(script, {
            currentUpdate: null,
            structuredClone,
            getComputedStyle: () => ({ color: '', fontSize: '', getPropertyValue: () => '' }),
            document: {
              getElementById: (id: string) => {
                if (id === 'startup-brand-canvas') {
                  return { dataset: { startupLogoBounds: JSON.stringify(brandBounds) } }
                }
                if (id === 'startup-toast') {
                  return { dataset: { sequence: '7' }, hidden: false, textContent: 'Copied' }
                }
                return undefined
              },
              querySelectorAll: () => [],
            },
          }),
      },
    }
    const snapshot = await inspectStartupSplash(window as unknown as BrowserWindow)
    expect(snapshot.brandBounds).toEqual(brandBounds)
    expect(snapshot.toastSequence).toBe(7)
  })

  test('retains a slow state that ended before the workbench controller connected', async () => {
    vi.useFakeTimers()
    const window = new EventEmitter()
    let snapshot: StartupSplashInspection = {
      progress: null,
      stepCount: 'Step 9 of 9',
      slowHidden: false,
      timeoutHidden: true,
    }
    const observer = observeStartupSplash(window as BrowserWindow, async () => snapshot)
    await vi.advanceTimersByTimeAsync(50)
    snapshot = { ...snapshot, slowHidden: true, timeoutHidden: false }
    await vi.advanceTimersByTimeAsync(50)
    const result = await observer.inspect()
    expect(result.slowHidden).toBe(true)
    expect(result.observations).toEqual([
      expect.objectContaining({ slowHidden: false, timeoutHidden: true }),
      expect.objectContaining({ slowHidden: true, timeoutHidden: false }),
    ])
    window.emit('closed')
  })

  test('records a toast while it is visible even if it hides before inspection', async () => {
    vi.useFakeTimers()
    const window = new EventEmitter()
    let snapshot: StartupSplashInspection = {
      progress: null,
      toastHidden: true,
      toastSequence: 0,
      toastText: '',
    }
    const observer = observeStartupSplash(window as BrowserWindow, async () => snapshot)
    await vi.advanceTimersByTimeAsync(50)
    snapshot = {
      toastHidden: false,
      toastSequence: 1,
      toastText: 'Diagnostics copied',
      progress: null,
    }
    await vi.advanceTimersByTimeAsync(50)
    snapshot = { ...snapshot, toastHidden: true }
    await vi.advanceTimersByTimeAsync(50)
    snapshot = { ...snapshot, toastHidden: false, toastSequence: 2 }
    await vi.advanceTimersByTimeAsync(50)
    const result = await observer.inspect()
    expect(result.toastHidden).toBe(false)
    expect(result.toastSequence).toBe(2)
    expect(result.observations).toContainEqual(
      expect.objectContaining({
        toastHidden: false,
        toastSequence: 1,
        toastText: 'Diagnostics copied',
      })
    )
    window.emit('closed')
  })

  test('bounds history, ignores frame updates, and stops reading when the window closes', async () => {
    vi.useFakeTimers()
    const window = new EventEmitter()
    let snapshot: StartupSplashInspection = { progress: null, title: 'Starting', progressNow: '0' }
    const inspect = vi.fn(async () => snapshot)
    const observer = observeStartupSplash(window as BrowserWindow, inspect)
    await vi.advanceTimersByTimeAsync(50)
    snapshot = { ...snapshot, progressNow: '1' }
    await vi.advanceTimersByTimeAsync(50)
    expect((await observer.inspect()).observations).toHaveLength(1)
    for (let index = 0; index < 80; index += 1) {
      snapshot = { ...snapshot, title: `Starting ${index}` }
      await vi.advanceTimersByTimeAsync(50)
    }
    expect((await observer.inspect()).observations).toHaveLength(64)
    window.emit('closed')
    inspect.mockClear()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(inspect).not.toHaveBeenCalled()
  })

  test('does not overlap slow reads and exposes an observation failure', async () => {
    vi.useFakeTimers()
    const window = new EventEmitter()
    let resolve: (snapshot: StartupSplashInspection) => void = () => {}
    const pending = new Promise<StartupSplashInspection>(done => {
      resolve = done
    })
    const inspect = vi.fn(() => pending)
    const observer = observeStartupSplash(window as BrowserWindow, inspect)
    await vi.advanceTimersByTimeAsync(500)
    expect(inspect).toHaveBeenCalledOnce()
    resolve({ progress: null })
    await vi.advanceTimersByTimeAsync(0)
    inspect.mockRejectedValueOnce(new Error('Native splash read failed'))
    await vi.advanceTimersByTimeAsync(50)
    await expect(observer.inspect()).rejects.toThrow('Native splash read failed')
    window.emit('closed')
  })
})
