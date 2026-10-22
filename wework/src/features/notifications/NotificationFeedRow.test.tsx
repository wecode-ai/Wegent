import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NotificationFeedRow, type NotificationFeedRowProps } from './NotificationFeedRow'

const props: NotificationFeedRowProps = {
  testId: 'notification-row',
  title: 'Review PR',
  body: 'Check the changes',
  timestamp: Date.parse('2026-10-21T12:05:00Z'),
  unread: true,
  unreadLabel: 'Unread',
  busy: false,
  onClick: vi.fn(),
}

describe('notification row navigation', () => {
  it('opens the destination once through the accessible navigation button', () => {
    const onClick = vi.fn()
    render(<NotificationFeedRow {...props} onClick={onClick} />)

    fireEvent.click(screen.getByRole('button', { name: /Review PR/ }))

    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByTestId('notification-row')).toHaveAttribute('data-unread', 'true')
  })

  it('disables navigation while busy', () => {
    const onClick = vi.fn()
    render(<NotificationFeedRow {...props} busy onClick={onClick} />)

    fireEvent.click(screen.getByTestId('notification-row'))

    expect(screen.getByTestId('notification-row')).toBeDisabled()
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keeps inline controls outside the navigation button', () => {
    const onClick = vi.fn()
    const onDelegate = vi.fn()
    const onReply = vi.fn()
    render(
      <NotificationFeedRow
        {...props}
        onClick={onClick}
        processing={
          <form onSubmit={event => event.preventDefault()}>
            <button type="button" onClick={onDelegate}>
              Delegate
            </button>
            <input aria-label="Reply" onChange={onReply} />
          </form>
        }
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }))
    fireEvent.click(screen.getByRole('textbox', { name: 'Reply' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), {
      target: { value: 'Also check ordering' },
    })

    expect(onDelegate).toHaveBeenCalledOnce()
    expect(onReply).toHaveBeenCalledOnce()
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delegate' }).closest('button')).not.toBe(
      screen.getByTestId('notification-row')
    )
  })
})
