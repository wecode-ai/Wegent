import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'

interface MockMessageListProps {
  virtualAnchorToEnd?: boolean
}

vi.mock('./MessageList', () => ({
  MessageList: ({ virtualAnchorToEnd }: MockMessageListProps) => (
    <div
      data-testid="virtual-message-list"
      data-virtual-anchor-to={virtualAnchorToEnd ? 'end' : 'start'}
    />
  ),
}))

describe('ScrollableMessageArea virtual layout ownership', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        observe() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('releases the virtual end anchor after the user scrolls away from the bottom', () => {
    render(
      <ScrollableMessageArea
        conversationKey="paused-virtual-layout"
        messages={[
          {
            id: 'streaming-message',
            role: 'assistant',
            content: 'Visible streaming paragraph',
            status: 'streaming',
            createdAt: '2026-08-18T00:00:00.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_200, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 300,
      writable: true,
      configurable: true,
    })
    expect(screen.getByTestId('virtual-message-list')).toHaveAttribute(
      'data-virtual-anchor-to',
      'end'
    )

    scroller.scrollTop = 1_000
    fireEvent.scroll(scroller)
    scroller.scrollTop = 300
    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    expect(screen.getByTestId('virtual-message-list')).toHaveAttribute(
      'data-virtual-anchor-to',
      'start'
    )
  })
})
