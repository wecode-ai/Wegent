import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useIsDesktop } from './useIsDesktop'

const originalWidth = window.innerWidth
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
})

it('keeps the shell breakpoint while allowing a panel to follow its own composition', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
  expect(renderHook(() => useIsDesktop()).result.current).toBe(true)
  expect(renderHook(() => useIsDesktop(1024)).result.current).toBe(false)
})

it('tracks the panel breakpoint and releases its media listener', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
  let change!: (event: MediaQueryListEvent) => void
  const remove = vi.fn()
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query =>
      ({
        media: query,
        matches: false,
        addEventListener: (_event: string, listener: typeof change) => {
          change = listener
        },
        removeEventListener: remove,
      }) as MediaQueryList
  )
  const { result, unmount } = renderHook(() => useIsDesktop(1024))
  expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1024px)')
  expect(result.current).toBe(false)
  act(() => change({ matches: true } as MediaQueryListEvent))
  expect(result.current).toBe(true)
  act(() => change({ matches: false } as MediaQueryListEvent))
  expect(result.current).toBe(false)
  unmount()
  expect(remove).toHaveBeenCalledWith('change', change)
})
