import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'

interface MockMessageListProps {
  conversationKey?: string | number | null
  virtualAnchorToEnd?: boolean
}

let resizeObserverCallback: ResizeObserverCallback | null = null

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
}))

vi.mock('./MessageList', () => ({
  MessageList: ({ conversationKey, virtualAnchorToEnd }: MockMessageListProps) => (
    <div
      data-testid="virtual-message-list"
      data-conversation-key={conversationKey ?? 'keyless'}
      data-virtual-anchor-to={virtualAnchorToEnd ? 'end' : 'start'}
    />
  ),
}))

describe('ScrollableMessageArea virtual layout ownership', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback
        }

        observe() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    resizeObserverCallback = null
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

  test('switches bottom-pinned conversations without synchronously measuring layout', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1)
    const message = (id: string) => ({
      id,
      role: 'assistant' as const,
      content: `Conversation ${id}`,
      status: 'done' as const,
      createdAt: '2026-08-29T00:00:00.000Z',
    })
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="long-a" messages={[message('a')]} />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    const scrollHeightGetter = vi.fn(() => 10_000)
    Object.defineProperty(scroller, 'scrollHeight', {
      get: scrollHeightGetter,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 9_000,
      writable: true,
      configurable: true,
    })
    const firstConversationList = screen.getByTestId('virtual-message-list')

    rerender(<ScrollableMessageArea conversationKey="long-b" messages={[message('b')]} />)
    const secondConversationList = screen.getByTestId('virtual-message-list')
    expect(secondConversationList).not.toBe(firstConversationList)
    expect(secondConversationList).toHaveAttribute('data-conversation-key', 'long-b')
    rerender(
      <ScrollableMessageArea
        conversationKey="long-b"
        messages={[message('b'), message('b-follow-up')]}
      />
    )
    const callback = resizeObserverCallback
    expect(callback).not.toBeNull()
    act(() => {
      callback!([], {} as ResizeObserver)
    })

    expect(scrollHeightGetter).not.toHaveBeenCalled()
    requestAnimationFrameSpy.mockRestore()
  })

  test('releases virtual ownership for a keyless conversation after the first layout', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1)
    render(
      <ScrollableMessageArea
        conversationKey={null}
        messages={[
          {
            id: 'keyless-message',
            role: 'assistant',
            content: 'Keyless conversation',
            status: 'done',
            createdAt: '2026-08-29T00:00:00.000Z',
          },
        ]}
      />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    const scrollHeightGetter = vi.fn(() => 10_000)
    Object.defineProperty(scroller, 'scrollHeight', {
      get: scrollHeightGetter,
      configurable: true,
    })
    const callback = resizeObserverCallback
    expect(callback).not.toBeNull()

    act(() => {
      callback!([], {} as ResizeObserver)
    })
    expect(scrollHeightGetter).not.toHaveBeenCalled()

    act(() => {
      callback!([], {} as ResizeObserver)
    })
    expect(scrollHeightGetter).toHaveBeenCalled()
    requestAnimationFrameSpy.mockRestore()
  })
})
