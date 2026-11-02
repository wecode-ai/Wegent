import type { BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  observeStartupSplash,
  type StartupSplashInspection,
} from './startup-splash-verification.js'

afterEach(() => vi.useRealTimers())

describe('native startup splash observations', () => {
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
