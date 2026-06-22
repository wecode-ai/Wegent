import { act, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TransientNotice } from './TransientNotice'

describe('TransientNotice', () => {
  test('renders status notice and clears after the timeout', async () => {
    vi.useFakeTimers()
    const onClear = vi.fn()

    render(<TransientNotice message="Saved" onClear={onClear} />)

    expect(screen.getByRole('status')).toHaveTextContent('Saved')
    expect(screen.getByTestId('transient-notice')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2200)
    })

    expect(onClear).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
