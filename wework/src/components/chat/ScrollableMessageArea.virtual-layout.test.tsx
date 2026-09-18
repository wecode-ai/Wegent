import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'

interface MockMessageListProps {
  conversationKey?: string | number | null
  virtualAnchorToEnd?: boolean
  onVirtualLayoutChange?: () => void
}

let resizeObserverCallback: ResizeObserverCallback | null = null
let virtualLayoutCallback: (() => void) | undefined

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => true,
}))

vi.mock('../../../../packages/collaboration/src/conversation/MessageList', () => ({
  MessageList: ({
    conversationKey,
    virtualAnchorToEnd,
    onVirtualLayoutChange,
  }: MockMessageListProps) => {
    virtualLayoutCallback = onVirtualLayoutChange
    return (
      <div
        data-testid="virtual-message-list"
        data-conversation-key={conversationKey ?? 'keyless'}
        data-virtual-anchor-to={virtualAnchorToEnd ? 'end' : 'start'}
      >
        <article data-message-id="1">
          <p data-scroll-anchor>Text</p>
        </article>
      </div>
    )
  },
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
    virtualLayoutCallback = undefined
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

  test('restores the reading anchor on virtual commit before a resize notification', () => {
    render(
      <ScrollableMessageArea
        conversationKey="1"
        scrollOrigin="bottom"
        messages={[
          { id: '1', role: 'assistant', content: 'Text', status: 'streaming', createdAt: '' },
        ]}
      />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    const anchor = screen.getByText('Text')
    let scrollHeight = 1_200
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: -160 },
    })
    scroller.getBoundingClientRect = () => new DOMRect(0, 100, 320, 200)
    anchor.getBoundingClientRect = () =>
      new DOMRect(0, 1_000 - (scrollHeight - 200 + scroller.scrollTop), 320, 40)
    // Release initial positioning ownership before simulating reader input.
    act(() => virtualLayoutCallback?.())
    fireEvent.wheel(scroller, { deltaY: -12 })
    fireEvent.scroll(scroller)
    const anchorTop = anchor.getBoundingClientRect().top

    scrollHeight += 40
    expect(anchor.getBoundingClientRect().top).toBe(anchorTop - 40)
    expect(virtualLayoutCallback).toBeTypeOf('function')
    act(() => virtualLayoutCallback!())

    expect(anchor.getBoundingClientRect().top).toBe(anchorTop)
    expect(scroller.scrollTop).toBe(-200)
    act(() => resizeObserverCallback!([], {} as ResizeObserver))
    expect(scroller.scrollTop).toBe(-200)
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
