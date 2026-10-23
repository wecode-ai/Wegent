import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useDebugSnapshotPublisher } from './useDebugSnapshotPublisher'

afterEach(() => vi.useRealTimers())

test('publishes the latest committed state while updates continue faster than the interval', () => {
  vi.useFakeTimers()
  const publish = vi.fn()
  const hook = renderHook(({ value }) => useDebugSnapshotPublisher(true, () => publish(value)), {
    initialProps: { value: 0 },
  })
  for (let value = 1; value < 10; value += 1) {
    act(() => vi.advanceTimersByTime(10))
    hook.rerender({ value })
  }
  act(() => vi.advanceTimersByTime(10))
  expect(publish).toHaveBeenCalledExactlyOnceWith(9)
})

test('cancels pending publication when disabled or unmounted', () => {
  vi.useFakeTimers()
  const publish = vi.fn()
  const hook = renderHook(({ enabled }) => useDebugSnapshotPublisher(enabled, publish), {
    initialProps: { enabled: true },
  })
  hook.rerender({ enabled: false })
  act(() => vi.advanceTimersByTime(100))
  expect(publish).not.toHaveBeenCalled()
  hook.rerender({ enabled: true })
  hook.unmount()
  act(() => vi.advanceTimersByTime(100))
  expect(publish).not.toHaveBeenCalled()
})
