import { afterEach, describe, expect, test, vi } from 'vitest'
import { cancelSafeAnimationFrame, requestSafeAnimationFrame } from './safeAnimationFrame'

describe('safeAnimationFrame', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('defers a synchronous animation-frame implementation to one fallback frame', () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 7
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const callback = vi.fn()

    const handle = requestSafeAnimationFrame(callback)
    expect(callback).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(callback).toHaveBeenCalledTimes(1)

    cancelSafeAnimationFrame(handle)
    expect(cancelFrame).toHaveBeenCalledWith(7)
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
