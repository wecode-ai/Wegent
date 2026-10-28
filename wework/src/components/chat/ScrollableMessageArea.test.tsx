import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { getConversationDiagnosticsSnapshot } from '@wegent/collaboration/conversation/conversationDiagnostics'
import {
  installScrollTestEnvironment,
  allResizeCallbacks,
  flushObservedLayout,
  fromBottom,
  messageText,
  mockRect,
  flushScheduledTimers,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: presentation', () => {
  installScrollTestEnvironment()
  afterEach(() => vi.restoreAllMocks())

  test('samples a bubbling wheel event once across the conversation and external viewport', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="bubbling-wheel"
          externalScrollRef={externalScrollRef}
          messages={[
            { id: 'message', role: 'assistant', content: 'Reading', status: 'done', createdAt: '' },
          ]}
        />
      </div>
    )
    fireEvent.wheel(screen.getByTestId('chat-message-scroll-area'), { deltaY: -120 })
    const inputs = getConversationDiagnosticsSnapshot()!.events.filter(
      event => event.name === 'scroll-input'
    )
    expect(inputs).toHaveLength(1)
    expect(inputs[0].details.deltaY).toBe(-120)
  })

  test('renders a centered empty state when the conversation has no messages', () => {
    render(<ScrollableMessageArea messages={[]} />)

    const emptyState = screen.getByTestId('chat-empty-state')
    expect(emptyState).toHaveClass('min-h-full', 'items-center', 'justify-center')
    expect(emptyState).toHaveTextContent('开始新的对话')
  })

  test('renders a loading state instead of the new conversation empty state', () => {
    render(<ScrollableMessageArea messages={[]} loading />)

    expect(screen.getByTestId('chat-loading-state')).toHaveTextContent('正在加载会话')
    expect(screen.queryByTestId('chat-empty-state')).not.toBeInTheDocument()
  })

  test('shows history failure and retries instead of displaying a new conversation', () => {
    const retry = vi.fn()
    const { rerender } = render(
      <ScrollableMessageArea
        messages={[]}
        transcriptError="Transfer interrupted"
        onRetryTranscript={retry}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('会话历史加载失败')
    expect(screen.getByRole('alert')).toHaveTextContent('Transfer interrupted')
    expect(screen.queryByTestId('chat-empty-state')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('runtime-transcript-retry'))
    expect(retry).toHaveBeenCalledOnce()
    rerender(<ScrollableMessageArea messages={[]} loading />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-loading-state')).toBeInTheDocument()
  })

  test.each([true, false])('top-aligns four short messages with virtualization %s', virtualize => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    render(
      <ScrollableMessageArea
        virtualize={virtualize}
        messages={[
          {
            id: '1',
            role: 'user',
            content: '执行pwd',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
          {
            id: '2',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:01.000Z',
          },
          {
            id: '3',
            role: 'user',
            content: 'Continue',
            status: 'done',
            createdAt: '2026-05-29T00:00:02.000Z',
          },
          {
            id: '4',
            role: 'assistant',
            content: 'Done',
            status: 'done',
            createdAt: '2026-05-29T00:00:03.000Z',
          },
        ]}
      />
    )

    const content = screen.getByTestId('chat-message-scroll-area-content')
    expect(content).toHaveClass('flex', 'flex-col', 'flex-1', 'shrink-0')
    expect(content).not.toHaveClass('justify-end')
    expect(
      [...content.querySelectorAll('[data-message-id]')].map(row =>
        row.getAttribute('data-message-id')
      )
    ).toEqual(['1', '2', '3', '4'])
  })

  test('uses normal coordinates for an internal conversation preview', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'normal-coordinate-preview',
            role: 'assistant',
            content: '最新消息直接出现在底部',
            status: 'done',
            createdAt: '2026-09-10T00:00:00.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    expect(scroller).toHaveAttribute('data-scroll-origin', 'top')
    expect(scroller).toHaveClass('flex', 'flex-col', '[overflow-anchor:none]')
    expect(scroller.scrollTop).toBeCloseTo(0)
  })

  test('updates the message list layout when only the layout class changes', () => {
    const messages = [
      {
        id: '1',
        role: 'assistant' as const,
        content: 'Ready',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:00.000Z',
      },
    ]
    const { rerender } = render(
      <ScrollableMessageArea messages={messages} messageListClassName="layout-width-a" />
    )

    expect(screen.getByTestId('message-assistant').parentElement).toHaveClass('layout-width-a')

    rerender(<ScrollableMessageArea messages={messages} messageListClassName="layout-width-b" />)

    expect(screen.getByTestId('message-assistant').parentElement).toHaveClass('layout-width-b')
    expect(screen.getByTestId('message-assistant').parentElement).not.toHaveClass('layout-width-a')
  })

  test('renders an optional sticky footer inside the scroll flow', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: '1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
        stickyFooterClassName="footer-shell"
        stickyFooter={<div data-testid="composer-footer">Composer</div>}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    const content = screen.getByTestId('chat-message-scroll-area-content')
    const footer = screen.getByTestId('chat-message-scroll-area-sticky-footer')

    expect(scroller).toHaveClass('flex', 'flex-col')
    expect(content).toHaveClass('flex-1', 'shrink-0')
    expect(footer).toHaveClass('sticky', 'bottom-0', 'z-10', 'footer-shell')
    expect(footer).toContainElement(screen.getByTestId('composer-footer'))
    expect(scroller.lastElementChild).toBe(footer)
  })

  test('renders an optional content footer directly after the message list', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: '1',
            role: 'user',
            content: 'Create a worktree',
            status: 'done',
            createdAt: '2026-08-11T00:00:00.000Z',
          },
        ]}
        contentFooterClassName="content-footer-shell"
        contentFooter={<div data-testid="creation-status">Creating worktree</div>}
      />
    )

    const content = screen.getByTestId('chat-message-scroll-area-content')
    const messageList = screen.getByTestId('message-user').parentElement
    const footer = screen.getByTestId('chat-message-scroll-area-content-footer')

    expect(footer).toHaveClass('content-footer-shell')
    expect(footer).toContainElement(screen.getByTestId('creation-status'))
    expect(content.lastElementChild).toBe(footer)
    expect(messageList?.nextElementSibling).toBe(footer)
  })

  test('keeps older transcript loading controls at the top of the message flow', () => {
    render(
      <ScrollableMessageArea
        hasMoreBefore
        messages={[
          {
            id: '1',
            role: 'assistant',
            content: '历史消息',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('chat-message-scroll-area-content')).not.toHaveClass('justify-end')
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toBeInTheDocument()
  })

  test('preserves the visible text when older transcript messages are prepended', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
          allResizeCallbacks.add(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
    const onLoadMoreBefore = vi.fn()
    const currentMessages = [
      {
        id: 'current',
        role: 'assistant' as const,
        content: 'Current page',
        status: 'done' as const,
        createdAt: '2026-08-10T00:00:01.000Z',
      },
    ]
    const { rerender } = render(
      <ScrollableMessageArea
        conversationKey="paginated-scroll"
        hasMoreBefore
        messages={currentMessages}
        onLoadMoreBefore={onLoadMoreBefore}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    let scrollHeight = 1_000
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 300,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })
    flushScheduledTimers()
    scroller.scrollTop = 300
    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)

    let anchorPosition = 340
    const anchor = messageText('Current page')
    mockRect(scroller, 0, 300)
    anchor.getBoundingClientRect = () =>
      new DOMRect(0, anchorPosition - scroller.scrollTop, 320, 80)
    fireEvent.click(screen.getByTestId('load-older-runtime-transcript-button'))
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()

    scrollHeight = 1_600
    anchorPosition += 600
    rerender(
      <ScrollableMessageArea
        conversationKey="paginated-scroll"
        messages={[
          {
            id: 'older',
            role: 'user',
            content: 'Older page',
            status: 'done',
            createdAt: '2026-08-10T00:00:00.000Z',
          },
          ...currentMessages,
        ]}
        onLoadMoreBefore={onLoadMoreBefore}
      />
    )
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })

    expect(scroller.scrollTop).toBe(900)
    expect(anchor.getBoundingClientRect().top).toBe(40)
  })

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
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    expect(scroller).toHaveClass('overflow-y-auto')
    expect(scroller).not.toHaveClass('overflow-x-hidden', 'overflow-x-clip')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn()

    fireEvent.scroll(scroller)

    const button = screen.getByTestId('scroll-to-bottom-button')
    expect(button).toBeInTheDocument()

    fireEvent.click(button)
    act(() => {
      flushObservedLayout()
      vi.advanceTimersByTime(0)
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: fromBottom(scroller, 0),
      behavior: 'auto',
    })
  })

  test('keeps following the bottom after the scroll button is clicked during layout growth', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
        allResizeCallbacks.add(callback)
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)

    render(
      <ScrollableMessageArea
        conversationKey="scroll-button-layout-growth"
        messages={[
          {
            id: '1',
            role: 'assistant',
            content: '长内容',
            status: 'done',
            createdAt: '2026-08-31T00:00:00.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    let scrollHeight = 600
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top, behavior }: ScrollToOptions) => {
      scroller.scrollTop = behavior === 'smooth' ? 80 : Number(top)
      fireEvent.scroll(scroller)
    })

    fireEvent.wheel(scroller, { deltaY: -120 })
    fireEvent.scroll(scroller)
    const button = screen.getByTestId('scroll-to-bottom-button')

    fireEvent.pointerDown(button)
    fireEvent.click(button)
    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(scroller.scrollTop).toBe(fromBottom(scroller, 0))

    scrollHeight = 900
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })

    expect(scroller.scrollTop).toBe(fromBottom(scroller, 0))
    expect(screen.queryByTestId('scroll-to-bottom-button')).not.toBeInTheDocument()
  })

  test('does not auto-scroll from content resize while auto-scroll is suspended', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    const originalResizeObserver = globalThis.ResizeObserver

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
        allResizeCallbacks.add(callback)
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)

    try {
      render(
        <ScrollableMessageArea
          autoScrollSuspended
          messages={[
            {
              id: 'resize-suspended',
              role: 'assistant',
              content: 'Ready',
              status: 'done',
              createdAt: '2026-05-29T00:00:00.000Z',
            },
          ]}
        />
      )

      const scroller = screen.getByTestId('chat-message-scroll-area')
      expect(scroller).toHaveClass('[overflow-anchor:none]')
      expect(screen.getByTestId('chat-message-scroll-area-content')).toHaveClass(
        '[overflow-anchor:none]'
      )
      Object.defineProperty(scroller, 'clientHeight', {
        value: 200,
        configurable: true,
      })
      Object.defineProperty(scroller, 'scrollHeight', {
        value: 600,
        configurable: true,
      })
      Object.defineProperty(scroller, 'scrollTop', {
        value: 352,
        writable: true,
        configurable: true,
      })
      scroller.scrollTo = vi.fn()

      act(() => {
        resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      })

      expect(scroller.scrollTo).not.toHaveBeenCalled()
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
    }
  })
})
