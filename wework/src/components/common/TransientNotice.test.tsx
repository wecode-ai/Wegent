import { act, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TransientNotice } from './TransientNotice'

afterEach(() => {
  vi.useRealTimers()
})

test('keeps the dismissal deadline across parent rerenders', () => {
  vi.useFakeTimers()
  const clear = vi.fn()
  const { rerender } = render(<TransientNotice message="已回复" onClear={clear} />)

  act(() => vi.advanceTimersByTime(1200))
  rerender(<TransientNotice message="已回复" onClear={() => clear()} />)
  act(() => vi.advanceTimersByTime(1100))

  expect(clear).toHaveBeenCalledOnce()
})
