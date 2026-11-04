import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useDebugSnapshotPublisher } from './useDebugSnapshotPublisher'

afterEach(() => vi.useRealTimers())

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
