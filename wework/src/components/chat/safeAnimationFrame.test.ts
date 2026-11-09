import { afterEach, describe, expect, test, vi } from 'vitest'
import { cancelSafeAnimationFrame, requestSafeAnimationFrame } from './safeAnimationFrame'

describe('safeAnimationFrame', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('cancels a pending synchronous fallback', () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 11
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const callback = vi.fn()

    const handle = requestSafeAnimationFrame(callback)
    cancelSafeAnimationFrame(handle)
    vi.runAllTimers()

    expect(callback).not.toHaveBeenCalled()
  })
})
