// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TransientNotice } from './TransientNotice'

afterEach(() => vi.useRealTimers())

it('keeps retry notices pending and never clears a replacement when the previous toast unmounts', async () => {
  vi.useFakeTimers()
  const clear = vi.fn()
  const retry = { label: 'Retry', testId: 'notice-retry', onClick: vi.fn(), pending: true }
  const view = render(
    <TransientNotice message="Failed" tone="error" onClear={clear} action={retry} />
  )
  try {
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(clear).not.toHaveBeenCalled()
    expect(view.getByTestId('notice-retry')).toHaveProperty('disabled', true)
    view.rerender(<TransientNotice message="Saved" onClear={clear} />)
    expect(clear).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(2201))
    expect(clear).toHaveBeenCalledTimes(1)
    view.unmount()
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(clear).toHaveBeenCalledTimes(1)
  } finally {
    view.unmount()
  }
})
