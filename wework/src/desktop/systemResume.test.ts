import { afterEach, describe, expect, test, vi } from 'vitest'
import { subscribeSystemResume } from './systemResume'

describe('subscribeSystemResume', () => {
  afterEach(() => {
    delete window.weworkElectronLifecycle
  })

  test('subscribes through the Electron lifecycle preload bridge', () => {
    const listener = vi.fn()
    const unsubscribe = vi.fn()
    const onSystemResume = vi.fn(() => unsubscribe)
    window.weworkElectronLifecycle = { onSystemResume }

    const cleanup = subscribeSystemResume(listener)

    expect(onSystemResume).toHaveBeenCalledWith(listener)
    cleanup()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  test('is a no-op outside Electron', () => {
    expect(() => subscribeSystemResume(vi.fn())()).not.toThrow()
  })
})
