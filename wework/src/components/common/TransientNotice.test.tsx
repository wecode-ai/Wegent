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
    expect(screen.getByTestId('transient-notice')).toHaveAttribute(
      'data-embedded-browser-occlusion'
    )
    expect(screen.getByTestId('transient-notice')).toHaveClass('z-system')

    act(() => {
      vi.advanceTimersByTime(2200)
    })

    expect(onClear).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('portals and centers a notice within its horizontal anchor', () => {
    const anchor = document.createElement('div')
    anchor.getBoundingClientRect = () => ({
      bottom: 720,
      height: 600,
      left: 400,
      right: 900,
      top: 120,
      width: 500,
      x: 400,
      y: 120,
      toJSON: () => ({}),
    })
    document.body.append(anchor)
    const horizontalAnchorRef = { current: anchor }

    const { unmount } = render(
      <TransientNotice
        message="Saved"
        onClear={() => undefined}
        horizontalAnchorRef={horizontalAnchorRef}
      />
    )

    const notice = screen.getByTestId('transient-notice')
    expect(notice.parentElement).toBe(document.body)
    expect(notice).toHaveStyle({ left: '650px', maxWidth: '468px' })

    unmount()
    anchor.remove()
  })

  test('keeps the clear timer active while an anchored notice is hidden', () => {
    vi.useFakeTimers()
    const anchor = document.createElement('div')
    document.body.append(anchor)
    const onClear = vi.fn()

    const { rerender } = render(
      <TransientNotice
        message="Saved"
        onClear={onClear}
        horizontalAnchorRef={{ current: anchor }}
        visible={false}
      />
    )

    expect(screen.queryByTestId('transient-notice')).not.toBeInTheDocument()
    vi.advanceTimersByTime(2200)
    expect(onClear).toHaveBeenCalledTimes(1)

    rerender(
      <TransientNotice
        message={null}
        onClear={onClear}
        horizontalAnchorRef={{ current: anchor }}
        visible
      />
    )
    expect(screen.queryByTestId('transient-notice')).not.toBeInTheDocument()

    anchor.remove()
    vi.useRealTimers()
  })
})
