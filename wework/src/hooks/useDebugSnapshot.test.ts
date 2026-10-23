import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { useDebugSnapshot } from './useDebugSnapshot'

const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds))

afterEach(() => vi.useRealTimers())

test('publishes current state while updates continue without an idle gap', () => {
  vi.useFakeTimers()
  const published = vi.fn()
  const { rerender } = renderHook(
    ({ revision }) => useDebugSnapshot(true, () => published(revision)),
    { initialProps: { revision: 0 } }
  )

  for (let revision = 1; revision <= 12; revision += 1) {
    advance(25)
    rerender({ revision })
  }

  expect(published).toHaveBeenCalled()
  expect(published.mock.calls.at(-1)?.[0]).toBeGreaterThanOrEqual(8)
  expect(published.mock.calls.length).toBeLessThan(12)
})

test('cancels pending publication when disabled or unmounted', () => {
  vi.useFakeTimers()
  const published = vi.fn()
  const { rerender, unmount } = renderHook(({ enabled }) => useDebugSnapshot(enabled, published), {
    initialProps: { enabled: true },
  })

  advance(50)
  rerender({ enabled: false })
  advance(200)
  expect(published).not.toHaveBeenCalled()

  rerender({ enabled: true })
  advance(100)
  expect(published).toHaveBeenCalledTimes(1)

  rerender({ enabled: false })
  rerender({ enabled: true })
  unmount()
  advance(200)
  expect(published).toHaveBeenCalledTimes(1)
})

test('publishes after StrictMode replays effect setup and cleanup', () => {
  vi.useFakeTimers()
  const published = vi.fn()
  const { unmount } = renderHook(() => useDebugSnapshot(true, published), {
    wrapper: StrictMode,
  })

  advance(100)
  expect(published).toHaveBeenCalledTimes(1)
  unmount()
})
