import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'

describe('ScrollableMessageArea', () => {
  test('shows a scroll-to-bottom button when messages overflow above the bottom', async () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: '1',
            role: 'assistant',
            content: '长内容',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />,
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 600, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true })
    scroller.scrollTo = vi.fn()

    fireEvent.scroll(scroller)

    const button = screen.getByTestId('scroll-to-bottom-button')
    expect(button).toBeInTheDocument()

    await userEvent.click(button)

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: 600,
      behavior: 'smooth',
    })
  })
})
