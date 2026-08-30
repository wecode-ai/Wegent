import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useStreamingRenderGuard } from './useStreamingRenderGuard'

describe('useStreamingRenderGuard', () => {
  let intersectionCallback: IntersectionObserverCallback

  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class IntersectionObserverMock {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
        observe() {}
        disconnect() {}
      }
    )
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('pauses revealing while the streaming block is offscreen', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const { result, rerender } = renderHook(({ active }) => useStreamingRenderGuard(active), {
      initialProps: { active: false },
    })
    result.current.rootRef.current = document.createElement('div')
    rerender({ active: true })

    expect(result.current.shouldHoldBack()).toBe(false)
    act(() => {
      intersectionCallback([{ isIntersecting: false } as IntersectionObserverEntry], {} as never)
    })
    expect(result.current.shouldHoldBack()).toBe(true)
    act(() => {
      intersectionCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as never)
    })
    expect(result.current.shouldHoldBack()).toBe(false)
  })

  test('shares one FPS sampling loop across streaming blocks', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 3)
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const first = renderHook(() => useStreamingRenderGuard(true))
    const second = renderHook(() => useStreamingRenderGuard(true))

    expect(requestFrame).toHaveBeenCalledTimes(1)
    first.unmount()
    expect(cancelFrame).not.toHaveBeenCalled()
    second.unmount()
    expect(cancelFrame).toHaveBeenCalledTimes(1)
  })
})
