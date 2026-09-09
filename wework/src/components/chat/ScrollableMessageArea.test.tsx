import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { MessageTurnNavigation } from './MessageTurnNavigation'
import {
  cacheConversationScrollSnapshot,
  getConversationScrollSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import { projectRuntimeConversationTurns } from '@/features/workbench/runtimeConversationTurns'

function mockRect(element: Element, top: number, bottom: number) {
  element.getBoundingClientRect = vi.fn(
    () =>
      ({
        top,
        bottom,
        left: 0,
        right: 320,
        width: 320,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect
  )
}

function mockScrollRelativeRect(
  element: Element,
  scroller: HTMLElement,
  topAtScrollZero: number,
  height: number
) {
  element.getBoundingClientRect = vi.fn(() => {
    const top = topAtScrollZero - scroller.scrollTop
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 320,
      width: 320,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect
  })
}

function flushScheduledTimers() {
  act(() => {
    vi.runOnlyPendingTimers()
  })
}

function flushStreamingFollow() {
  act(() => {
    for (let frame = 0; frame < 180; frame += 1) {
      vi.runOnlyPendingTimers()
    }
  })
}

describe('ScrollableMessageArea', () => {
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn>
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        callback(0)
        return 1
      })
    cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
    vi.unstubAllGlobals()
    vi.useRealTimers()
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

  test('top-aligns short conversations below the workspace header', () => {
    render(
      <ScrollableMessageArea
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
            content: '',
            status: 'streaming',
            createdAt: '2026-05-29T00:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('chat-message-scroll-area-content')).not.toHaveClass('justify-end')
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

  test('preserves distance from the bottom when older transcript messages are prepended', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
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

    fireEvent.click(screen.getByTestId('load-older-runtime-transcript-button'))
    expect(onLoadMoreBefore).toHaveBeenCalledOnce()

    scrollHeight = 1_600
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
      vi.advanceTimersByTime(0)
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 600,
      behavior: 'smooth',
    })
  })

  test('keeps following the bottom after the scroll button is clicked during layout growth', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
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

    expect(scroller.scrollTop).toBe(600)

    scrollHeight = 900
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })

    expect(scroller.scrollTop).toBe(900)
    expect(screen.queryByTestId('scroll-to-bottom-button')).not.toBeInTheDocument()
  })

  test('does not auto-scroll from content resize while auto-scroll is suspended', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    const originalResizeObserver = globalThis.ResizeObserver

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
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

  test('keeps a visible text anchor fixed when paused content remeasures', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    const originalResizeObserver = globalThis.ResizeObserver

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)

    try {
      render(
        <ScrollableMessageArea
          conversationKey="width-reflow"
          messages={[
            {
              id: 'width-reflow-message',
              role: 'assistant',
              content: '正在阅读的长消息',
              status: 'done',
              createdAt: '2026-05-29T00:00:00.000Z',
            },
          ]}
        />
      )

      const scroller = screen.getByTestId('chat-message-scroll-area')
      const anchor = screen.getByText('正在阅读的长消息').closest('[data-scroll-anchor]')!
      Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
      Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
      Object.defineProperty(scroller, 'scrollTop', {
        value: 300,
        writable: true,
        configurable: true,
      })
      scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
        scroller.scrollTop = Number(top)
      })
      mockRect(scroller, 100, 300)
      mockScrollRelativeRect(anchor, scroller, 450, 40)

      scroller.scrollTop = 1000
      fireEvent.scroll(scroller)
      scroller.scrollTop = 300
      fireEvent.wheel(scroller)
      fireEvent.scroll(scroller)
      ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      Object.defineProperty(scroller, 'scrollHeight', { value: 1440, configurable: true })
      mockScrollRelativeRect(anchor, scroller, 690, 40)
      act(() => {
        resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      })

      expect(scroller.scrollTo).not.toHaveBeenCalled()
      expect(scroller.scrollTop).toBe(540)
      expect(anchor.getBoundingClientRect().top).toBe(150)
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
    }
  })

  test('keeps the user anchor when a width reflow clamps the scroller before resize observation', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )

    render(
      <ScrollableMessageArea
        conversationKey="width-reflow-clamp"
        messages={[
          {
            id: 'width-reflow-clamp-message',
            role: 'assistant',
            content: '关闭文件面板后仍在阅读的段落',
            status: 'done',
            createdAt: '2026-08-30T00:00:00.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    const anchor = screen.getByText('关闭文件面板后仍在阅读的段落').closest('[data-scroll-anchor]')!
    let scrollHeight = 2_000
    let anchorTopAtScrollZero = 1_300
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 1_800,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Math.min(Number(top), scrollHeight - scroller.clientHeight)
    })
    mockRect(scroller, 100, 300)
    anchor.getBoundingClientRect = vi.fn(() => {
      const top = anchorTopAtScrollZero - scroller.scrollTop
      return {
        top,
        bottom: top + 40,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect
    })

    fireEvent.scroll(scroller)
    scroller.scrollTop = 1_200
    fireEvent.wheel(scroller, { deltaY: -80 })
    fireEvent.scroll(scroller)

    scrollHeight = 1_300
    anchorTopAtScrollZero = 500
    scroller.scrollTop = 1_100
    fireEvent.scroll(scroller)
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })

    expect(scroller.scrollTop).toBe(400)
    expect(anchor.getBoundingClientRect().top).toBe(100)
  })

  test('keeps a bottom-origin user anchor when width reflow clamps toward zero', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )

    const externalScrollRef = createRef<HTMLDivElement>()
    render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="bottom-origin-width-reflow-clamp"
          externalScrollRef={externalScrollRef}
          messages={[
            {
              id: 'bottom-origin-width-reflow-clamp-message',
              role: 'assistant',
              content: '关闭文件面板后仍在阅读的段落',
              status: 'done',
              createdAt: '2026-08-31T00:00:00.000Z',
            },
          ]}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    const anchor = screen.getByText('关闭文件面板后仍在阅读的段落').closest('[data-scroll-anchor]')!
    let scrollHeight = 2_000
    let anchorContentTop = 1_200
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: -600,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 100, 300)
    anchor.getBoundingClientRect = vi.fn(() => {
      const contentScrollTop = scrollHeight - scroller.clientHeight + scroller.scrollTop
      const top = 100 + anchorContentTop - contentScrollTop
      return {
        top,
        bottom: top + 40,
        left: 0,
        right: 320,
        width: 320,
        height: 40,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect
    })

    fireEvent.wheel(scroller, { deltaY: -80 })
    fireEvent.scroll(scroller)

    scrollHeight = 10_000
    anchorContentTop = 9_100
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)

    scrollHeight = 1_300
    anchorContentTop = 400
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })

    expect(scroller.scrollTop).toBe(-700)
    expect(anchor.getBoundingClientRect().top).toBe(100)
  })

  test('keeps the first visible text line fixed when width changes reflow a paragraph', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    const originalResizeObserver = globalThis.ResizeObserver
    const originalCaretRangeDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'caretRangeFromPoint'
    )
    const originalGetClientRectsDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getClientRects'
    )

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)

    try {
      render(
        <ScrollableMessageArea
          conversationKey="line-width-reflow"
          messages={[
            {
              id: 'line-width-reflow-message',
              role: 'assistant',
              content: '第一行需要在调整对话宽度后保持原来的屏幕位置。',
              status: 'done',
              createdAt: '2026-05-29T00:00:00.000Z',
            },
          ]}
        />
      )

      const scroller = screen.getByTestId('chat-message-scroll-area')
      const anchor = screen
        .getByText('第一行需要在调整对话宽度后保持原来的屏幕位置。')
        .closest('[data-scroll-anchor]')!
      const textNode = anchor.firstChild!
      const caretRange = document.createRange()
      caretRange.setStart(textNode, 4)
      caretRange.collapse(true)
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: vi.fn(() => caretRange),
      })

      let lineTopAtScrollZero = 410
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: vi.fn(() => {
          const top = lineTopAtScrollZero - scroller.scrollTop
          return [
            {
              top,
              bottom: top + 24,
              left: 0,
              right: 240,
              width: 240,
              height: 24,
              x: 0,
              y: top,
              toJSON: () => ({}),
            } as DOMRect,
          ]
        }),
      })

      Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
      Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
      Object.defineProperty(scroller, 'scrollTop', {
        value: 300,
        writable: true,
        configurable: true,
      })
      scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
        scroller.scrollTop = Number(top)
      })
      mockRect(scroller, 100, 300)
      mockScrollRelativeRect(anchor, scroller, 250, 400)

      scroller.scrollTop = 1000
      fireEvent.scroll(scroller)
      scroller.scrollTop = 300
      fireEvent.wheel(scroller)
      fireEvent.scroll(scroller)

      lineTopAtScrollZero = 650
      Object.defineProperty(scroller, 'scrollHeight', { value: 1440, configurable: true })
      act(() => {
        resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      })

      expect(scroller.scrollTop).toBe(540)
      expect(lineTopAtScrollZero - scroller.scrollTop).toBe(110)
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
      if (originalCaretRangeDescriptor) {
        Object.defineProperty(document, 'caretRangeFromPoint', originalCaretRangeDescriptor)
      } else {
        Reflect.deleteProperty(document, 'caretRangeFromPoint')
      }
      if (originalGetClientRectsDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', originalGetClientRectsDescriptor)
      } else {
        Reflect.deleteProperty(Range.prototype, 'getClientRects')
      }
    }
  })

  test('tracks scrolling from the external desktop scroll container', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const messages = [
      {
        id: 'external-scroll-message',
        role: 'assistant' as const,
        content: '桌面外部滚动容器中的消息',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:00.000Z',
      },
    ]
    const { rerender } = render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-scroll-a"
          externalScrollRef={externalScrollRef}
          messages={messages}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: -480,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    rerender(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-scroll-b"
          externalScrollRef={externalScrollRef}
          messages={messages}
        />
      </div>
    )
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    scroller.scrollTop = 0
    rerender(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-scroll-a"
          externalScrollRef={externalScrollRef}
          messages={messages}
        />
      </div>
    )
    flushScheduledTimers()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: -480,
      behavior: 'auto',
    })
  })

  test('saves the bottom target instead of a smooth-scroll intermediate position', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-smooth-bottom"
          externalScrollRef={externalScrollRef}
          messages={[
            {
              id: 'external-smooth-bottom-message',
              role: 'assistant',
              content: '桌面外部滚动容器中的长消息',
              status: 'done',
              createdAt: '2026-08-31T00:00:00.000Z',
            },
          ]}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: -200,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn()

    fireEvent.wheel(scroller, { deltaY: -120 })
    fireEvent.scroll(scroller)
    const button = screen.getByTestId('scroll-to-bottom-button')

    fireEvent.pointerDown(button)
    fireEvent.click(button)
    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: -0,
      behavior: 'smooth',
    })
    expect(scroller.scrollTop).toBe(-200)
    expect(getConversationScrollSnapshot('external-smooth-bottom')).toEqual({
      distanceFromBottomPx: 0,
      pinnedToBottom: true,
    })
  })

  test('keeps following the external scroller when a virtualized response grows after render', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const completedMessage = {
      id: 'completed-message',
      role: 'assistant' as const,
      content: '已完成的长会话',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-growing-stream"
          externalScrollRef={externalScrollRef}
          messages={[completedMessage]}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    let scrollHeight = 1000
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.scroll(scroller)
    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    rerender(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-growing-stream"
          externalScrollRef={externalScrollRef}
          messages={[
            completedMessage,
            {
              id: 'late-measured-streaming-message',
              role: 'assistant',
              content: '刚开始流式输出',
              status: 'streaming',
              createdAt: '2026-05-29T00:00:01.000Z',
            },
          ]}
        />
      </div>
    )

    scrollHeight = 3000
    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: -0,
      behavior: 'auto',
    })
    expect(scroller.scrollTop).toBe(-0)
  })

  test('stops external bottom following when the scroll position leaves the bottom', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const streamingMessage = {
      id: 'external-streaming-message',
      role: 'assistant' as const,
      content: '正在流式输出',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-stream-a"
          externalScrollRef={externalScrollRef}
          messages={[streamingMessage]}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.scroll(scroller)
    rerender(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-stream-b"
          externalScrollRef={externalScrollRef}
          messages={[{ ...streamingMessage, id: 'external-streaming-message-b' }]}
        />
      </div>
    )
    rerender(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-stream-a"
          externalScrollRef={externalScrollRef}
          messages={[streamingMessage]}
        />
      </div>
    )

    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    scroller.scrollTop = -450
    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    flushScheduledTimers()

    expect(scroller.scrollTo).not.toHaveBeenCalled()
    expect(getConversationScrollSnapshot('external-stream-a')).toEqual({
      distanceFromBottomPx: 450,
      pinnedToBottom: false,
    })
  })

  test('renders a compact left-side navigation for previous user messages', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'user-1',
            role: 'user',
            content: '第一条用户需求',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '第一条回复摘要',
            status: 'done',
            createdAt: '2026-05-29T00:00:01.000Z',
          },
          {
            id: 'user-2',
            role: 'user',
            content: [
              '# Files mentioned by the user:',
              '',
              '## notes.txt: /tmp/notes.txt',
              '',
              '## My request for Codex:',
              '<application_context>',
              '[wework.terminal.current]',
              'Wework terminal context',
              '[referencedConversations]',
              JSON.stringify([
                {
                  role: 'user',
                  content:
                    '<application_context>\\n[source]\\nstate\\n</application_context>\\n\\nReferenced question',
                },
                {
                  role: 'assistant',
                  content: 'Referenced answer that must stay hidden',
                },
              ]),
              '</application_context>',
              '',
              '第二条用户需求',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-05-29T00:00:02.000Z',
          },
        ]}
        turnNavigation={[
          {
            id: 'user-1',
            turnIndex: 0,
            messageIndex: 0,
            cursor: 'offset:0',
            promptPreview: '第一条用户需求',
            responsePreview: '第一条回复摘要',
          },
          {
            id: 'provider-user-2',
            turnIndex: 1,
            messageIndex: 2,
            cursor: 'offset:2',
            promptPreview:
              '<application_context> [wework.terminal.current] Wework terminal context',
            responsePreview: '',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 300,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 0, 300)
    scroller.scrollTo = vi.fn()
    mockRect(screen.getByText('第一条用户需求').closest('[data-message-id]')!, 120, 180)
    mockRect(screen.getByText('第二条用户需求').closest('[data-message-id]')!, 620, 680)

    fireEvent.resize(window)
    flushScheduledTimers()

    const navigation = screen.getByTestId('message-turn-navigation')
    const markers = screen.getAllByTestId('message-turn-navigation-marker')
    expect(navigation).toHaveAccessibleName('历史发言导航')
    expect(navigation).toHaveClass('absolute')
    expect(navigation).toHaveClass('z-popover')
    expect(Number.parseFloat(navigation.style.height)).toBeCloseTo(18.222)
    expect(markers).toHaveLength(2)
    expect(markers[0]).toHaveAccessibleName('跳转到第 1 条发言')
    expect(markers[1]).toHaveAccessibleName('跳转到第 2 条发言')
    const activeMarkerIndicator = markers[0].querySelector('span')
    const nearbyMarkerIndicator = markers[1].querySelector('span')
    expect(activeMarkerIndicator).toHaveStyle({ width: '8px' })
    expect(nearbyMarkerIndicator).toHaveStyle({ width: '8px' })
    fireEvent.focus(markers[0])
    expect(activeMarkerIndicator).toHaveStyle({ width: '24px' })
    expect(nearbyMarkerIndicator).toHaveStyle({ width: '16px' })
    fireEvent.blur(markers[0])
    expect(activeMarkerIndicator).toHaveStyle({ width: '8px' })
    expect(nearbyMarkerIndicator).toHaveStyle({ width: '8px' })

    Object.defineProperty(scroller, 'scrollTop', {
      value: 620,
      writable: true,
      configurable: true,
    })
    fireEvent.scroll(scroller)
    expect(nearbyMarkerIndicator).toHaveClass('bg-text-primary')
    fireEvent.focus(markers[0])
    expect(nearbyMarkerIndicator).not.toHaveClass('bg-text-primary')
    fireEvent.blur(markers[0])
    expect(screen.getAllByText('第一条用户需求')).toHaveLength(2)
    expect(screen.getAllByText('第一条回复摘要')).toHaveLength(2)
    expect(screen.getAllByText('第二条用户需求')).toHaveLength(2)
    expect(screen.queryByText(/application_context/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Referenced answer that must stay hidden/)).not.toBeInTheDocument()
  })

  test('renders message navigation in an overlay outside the external scroller', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const portalTarget = document.createElement('div')
    portalTarget.dataset.testid = 'external-navigation-overlay'
    document.body.append(portalTarget)
    const messages = Array.from({ length: 2 }, (_, index) => ({
      id: `external-navigation-user-${index}`,
      role: 'user' as const,
      content: `外层滚动消息 ${index + 1}`,
      status: 'done' as const,
      createdAt: `2026-05-29T00:00:0${index}.000Z`,
      runtimeMessageIndex: index,
    }))

    render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          messages={messages}
          externalScrollRef={externalScrollRef}
          turnNavigationPortalTarget={portalTarget}
          turnNavigation={messages.map((message, index) => ({
            id: `runtime-${message.id}`,
            turnIndex: index,
            messageIndex: index,
            cursor: `offset:${index}`,
            promptPreview: message.content,
            responsePreview: '',
          }))}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true })
    scroller.scrollTo = vi.fn()
    mockRect(scroller, 0, 300)
    messages.forEach((message, index) => {
      mockRect(
        screen.getByText(message.content).closest('[data-message-id]')!,
        120 + index * 500,
        180 + index * 500
      )
    })

    fireEvent.resize(window)
    flushScheduledTimers()

    const navigation = screen.getByTestId('message-turn-navigation')
    const overlay = screen.getByTestId('external-navigation-overlay')
    expect(navigation).toHaveClass('absolute')
    expect(overlay).toContainElement(navigation)
    expect(externalScrollRef.current).not.toContainElement(navigation)

    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[1])
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 524, behavior: 'smooth' })

    portalTarget.remove()
  })

  test('keeps message navigation available while a cached external scroller is hidden', () => {
    const resizeObservers: Array<{
      callback: ResizeObserverCallback
      targets: Set<Element>
    }> = []
    const originalResizeObserver = globalThis.ResizeObserver
    class ResizeObserverMock {
      private readonly entry: (typeof resizeObservers)[number]

      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() }
        resizeObservers.push(this.entry)
      }

      observe(target: Element) {
        this.entry.targets.add(target)
      }

      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)

    try {
      const externalScrollRef = createRef<HTMLDivElement>()
      render(
        <div ref={externalScrollRef}>
          <ScrollableMessageArea
            externalScrollRef={externalScrollRef}
            messages={[
              {
                id: 'cached-user-1',
                role: 'user',
                content: '缓存会话第一条需求',
                status: 'done',
                createdAt: '2026-05-29T00:00:00.000Z',
              },
              {
                id: 'cached-assistant-1',
                role: 'assistant',
                content: '缓存会话第一条回复',
                status: 'done',
                createdAt: '2026-05-29T00:00:01.000Z',
              },
              {
                id: 'cached-user-2',
                role: 'user',
                content: '缓存会话第二条需求',
                status: 'done',
                createdAt: '2026-05-29T00:00:02.000Z',
              },
            ]}
          />
        </div>
      )

      const scroller = externalScrollRef.current!
      const scrollerObserver = resizeObservers.find(observer => observer.targets.has(scroller))
      expect(scrollerObserver).toBeDefined()
      flushScheduledTimers()

      expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(2)
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
    }
  })

  test('coalesces continuous virtualizer measurements without starving navigation', () => {
    const resizeObservers: Array<{ callback: ResizeObserverCallback }> = []
    const originalResizeObserver = globalThis.ResizeObserver
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeObservers.push({ callback })
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)

    try {
      render(
        <ScrollableMessageArea
          messages={[
            {
              id: 'measured-user-1',
              role: 'user',
              content: '第一条持续测量需求',
              status: 'done',
              createdAt: '2026-05-29T00:00:00.000Z',
            },
            {
              id: 'measured-assistant-1',
              role: 'assistant',
              content: '第一条持续测量回复',
              status: 'done',
              createdAt: '2026-05-29T00:00:01.000Z',
            },
            {
              id: 'measured-user-2',
              role: 'user',
              content: '第二条持续测量需求',
              status: 'done',
              createdAt: '2026-05-29T00:00:02.000Z',
            },
          ]}
        />
      )
      act(() => {
        for (let index = 0; index < 25; index += 1) {
          resizeObservers.forEach(observer => observer.callback([], observer as ResizeObserver))
        }
      })

      flushScheduledTimers()
      expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(2)
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
    }
  })

  test('updates message navigation when the runtime appends to the same messages array', () => {
    const messages = [
      {
        id: 'mutable-user-1',
        role: 'user' as const,
        content: '原地更新前的需求',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:00.000Z',
      },
      {
        id: 'mutable-assistant-1',
        role: 'assistant' as const,
        content: '原地更新前的回复',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:01.000Z',
      },
    ]
    const { rerender } = render(<ScrollableMessageArea messages={messages} />)
    flushScheduledTimers()
    expect(screen.queryByTestId('message-turn-navigation-marker')).not.toBeInTheDocument()

    messages.push({
      id: 'mutable-user-2',
      role: 'user',
      content: '原地追加的第二条需求',
      status: 'done',
      createdAt: '2026-05-29T00:00:02.000Z',
    })
    rerender(<ScrollableMessageArea messages={messages} isWaitingForAssistant />)
    flushScheduledTimers()

    expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(2)
  })

  test('does not reschedule marker calculation for unchanged turns', () => {
    const messages = [
      {
        id: 'stable-user-1',
        role: 'user' as const,
        content: '第一条稳定需求',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:00.000Z',
      },
      {
        id: 'stable-assistant-1',
        role: 'assistant' as const,
        content: '第一条稳定回复',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:01.000Z',
      },
      {
        id: 'stable-user-2',
        role: 'user' as const,
        content: '第二条稳定需求',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:02.000Z',
      },
    ]
    const querySelectorAllSpy = vi.spyOn(HTMLElement.prototype, 'querySelectorAll')
    const { rerender } = render(<ScrollableMessageArea messages={messages} />)
    flushScheduledTimers()
    querySelectorAllSpy.mockClear()

    rerender(<ScrollableMessageArea messages={[...messages]} />)
    flushScheduledTimers()

    expect(
      querySelectorAllSpy.mock.calls.filter(([selector]) =>
        String(selector).includes('[data-message-id]')
      )
    ).toHaveLength(0)
    querySelectorAllSpy.mockRestore()
  })

  test('uses newer transcript turns while runtime navigation metadata is catching up', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'live-user-1',
            role: 'user',
            content: '已进入导航摘要的需求',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
            runtimeMessageIndex: 0,
          },
          {
            id: 'live-assistant-1',
            role: 'assistant',
            content: '第一条回复',
            status: 'done',
            createdAt: '2026-05-29T00:00:01.000Z',
            runtimeMessageIndex: 1,
          },
          {
            id: 'live-user-2',
            role: 'user',
            content: '尚未进入导航摘要的新需求',
            status: 'done',
            createdAt: '2026-05-29T00:00:02.000Z',
            runtimeMessageIndex: 2,
          },
        ]}
        turnNavigation={[
          {
            id: 'live-user-1',
            turnIndex: 0,
            messageIndex: 0,
            cursor: 'offset:0',
            promptPreview: '已进入导航摘要的需求',
            responsePreview: '第一条回复',
          },
        ]}
      />
    )

    flushScheduledTimers()

    expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(2)
  })

  test('aligns the active navigation marker in the task-switch commit', () => {
    function NavigationFrame({ prefix }: { prefix: string }) {
      const scrollRef = useRef<HTMLDivElement>(null)
      const contentRef = useRef<HTMLDivElement>(null)
      const messages = [
        {
          id: `${prefix}-user-1`,
          role: 'user' as const,
          content: 'Earlier request',
          status: 'done' as const,
          createdAt: '2026-08-31T00:00:00.000Z',
        },
        {
          id: `${prefix}-user-2`,
          role: 'user' as const,
          content: 'Visible request',
          status: 'done' as const,
          createdAt: '2026-08-31T00:00:01.000Z',
        },
      ]

      return (
        <>
          <div
            ref={node => {
              scrollRef.current = node
              if (!node) return
              node.dataset.scrollOrigin = 'bottom'
              Object.defineProperties(node, {
                clientHeight: { value: 300, configurable: true },
                scrollHeight: { value: 1_000, configurable: true },
                scrollTop: { value: 0, writable: true, configurable: true },
              })
              mockRect(node, 0, 300)
            }}
          >
            <div ref={contentRef}>
              <div
                data-message-id={`${prefix}-user-1`}
                ref={node => {
                  if (node) mockRect(node, -650, -590)
                }}
              >
                Earlier request
              </div>
              <div
                data-message-id={`${prefix}-user-2`}
                ref={node => {
                  if (node) mockRect(node, 50, 110)
                }}
              >
                Visible request
              </div>
            </div>
          </div>
          <MessageTurnNavigation
            messages={messages}
            scrollRef={scrollRef}
            contentRef={contentRef}
          />
        </>
      )
    }

    const view = render(<NavigationFrame prefix="first-task" />)
    let markers = screen.getAllByTestId('message-turn-navigation-marker')
    expect(markers[0]).toHaveAttribute('data-active', 'false')
    expect(markers[1]).toHaveAttribute('data-active', 'true')

    view.rerender(<NavigationFrame prefix="second-task" />)

    markers = screen.getAllByTestId('message-turn-navigation-marker')
    expect(markers[0]).toHaveAttribute('data-active', 'false')
    expect(markers[1]).toHaveAttribute('data-active', 'true')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('deduplicates retry navigation entries that point to the same user message', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'original-user',
            role: 'user',
            content: '原始需求',
            status: 'done',
            createdAt: '2026-07-27T00:00:00.000Z',
            runtimeMessageIndex: 0,
          },
          {
            id: 'retry-user',
            role: 'user',
            content: '继续',
            status: 'done',
            createdAt: '2026-07-27T00:00:01.000Z',
            runtimeMessageIndex: 8,
          },
        ]}
        turnNavigation={[
          {
            id: 'original-user',
            turnIndex: 0,
            messageIndex: 0,
            cursor: 'offset:0',
            promptPreview: '原始需求',
            responsePreview: '',
          },
          ...[2, 4, 6, 8].map((messageIndex, index) => ({
            id: 'retry-user',
            turnIndex: index + 1,
            messageIndex,
            cursor: `offset:${messageIndex}`,
            promptPreview: '继续',
            responsePreview: '',
          })),
        ]}
      />
    )

    flushScheduledTimers()

    const markers = screen.getAllByTestId('message-turn-navigation-marker')
    expect(markers).toHaveLength(2)
    expect(markers[1]).toHaveAccessibleName('跳转到第 2 条发言')

    fireEvent.focus(markers[1])

    const visiblePreviews = screen
      .getAllByTestId('message-turn-navigation-preview')
      .filter(preview => preview.classList.contains('opacity-100'))
    expect(visiblePreviews).toHaveLength(1)
    expect(visiblePreviews[0]).toHaveTextContent('继续')
  })

  test('keeps message navigation available while its portal target is unavailable', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'fallback-navigation-user-1',
            role: 'user',
            content: '第一条回退消息',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
          {
            id: 'fallback-navigation-user-2',
            role: 'user',
            content: '第二条回退消息',
            status: 'done',
            createdAt: '2026-05-29T00:00:01.000Z',
          },
        ]}
        turnNavigationPortalTarget={null}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    mockRect(scroller, 0, 300)
    mockRect(screen.getByText('第一条回退消息').closest('[data-message-id]')!, 120, 180)
    mockRect(screen.getByText('第二条回退消息').closest('[data-message-id]')!, 620, 680)

    fireEvent.resize(window)
    flushScheduledTimers()

    expect(screen.getByTestId('message-turn-navigation')).toBeInTheDocument()
  })

  test('forces a loaded virtualized navigation target to mount before scrolling', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const contentRef = createRef<HTMLDivElement>()
    const onLoadTurnNavigationItem = vi.fn()
    const onNavigationScrollTargetChange = vi.fn()

    render(
      <>
        <div ref={scrollRef}>
          <div ref={contentRef} />
        </div>
        <MessageTurnNavigation
          messages={[
            {
              id: 'virtualized-user-1',
              role: 'user',
              content: 'Virtualized target',
              status: 'done',
              createdAt: '2026-07-25T00:00:00.000Z',
              runtimeMessageIndex: 0,
            },
            {
              id: 'virtualized-user-2',
              role: 'user',
              content: 'Mounted sibling turn',
              status: 'done',
              createdAt: '2026-07-25T00:00:01.000Z',
              runtimeMessageIndex: 2,
            },
          ]}
          turnNavigation={[
            {
              id: 'runtime-virtualized-user-1',
              turnIndex: 0,
              messageIndex: 0,
              cursor: 'offset:0',
              promptPreview: 'Virtualized target',
              responsePreview: '',
            },
            {
              id: 'runtime-virtualized-user-2',
              turnIndex: 1,
              messageIndex: 2,
              cursor: 'offset:2',
              promptPreview: 'Mounted sibling turn',
              responsePreview: '',
            },
          ]}
          scrollRef={scrollRef}
          contentRef={contentRef}
          onLoadTurnNavigationItem={onLoadTurnNavigationItem}
          onNavigationScrollTargetChange={onNavigationScrollTargetChange}
        />
      </>
    )

    const scroller = scrollRef.current!
    const content = contentRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 300, configurable: true })
    Object.defineProperty(content, 'scrollHeight', { value: 1_000, configurable: true })
    mockRect(scroller, 0, 300)
    mockRect(content, 0, 1_000)

    fireEvent.resize(window)
    flushScheduledTimers()
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])

    expect(onNavigationScrollTargetChange).toHaveBeenCalledWith('virtualized-user-1')
    expect(onLoadTurnNavigationItem).not.toHaveBeenCalled()
  })

  test('merges newly loaded user turns into stale runtime navigation metadata', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const contentRef = createRef<HTMLDivElement>()
    const messages = [
      {
        id: 'stale-navigation-user-1',
        role: 'user' as const,
        content: 'First loaded turn',
        status: 'done' as const,
        createdAt: '2026-07-25T00:00:00.000Z',
        runtimeMessageIndex: 0,
      },
      {
        id: 'stale-navigation-user-2',
        role: 'user' as const,
        content: 'Newly loaded turn',
        status: 'done' as const,
        createdAt: '2026-07-25T00:00:01.000Z',
        runtimeMessageIndex: 0,
      },
    ]

    render(
      <div ref={scrollRef}>
        <div ref={contentRef}>
          {messages.map(message => (
            <div key={message.id} data-message-id={message.id}>
              {message.content}
            </div>
          ))}
        </div>
        <MessageTurnNavigation
          messages={messages}
          turnNavigation={[
            {
              id: 'runtime-stale-navigation-user-1',
              turnIndex: 0,
              messageIndex: 0,
              cursor: 'offset:0',
              promptPreview: 'First loaded turn',
              responsePreview: '',
            },
          ]}
          scrollRef={scrollRef}
          contentRef={contentRef}
        />
      </div>
    )

    const scroller = scrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, configurable: true })
    mockRect(scroller, 0, 300)
    messages.forEach((message, index) => {
      mockRect(
        document.querySelector(`[data-message-id="${message.id}"]`)!,
        100 + index * 500,
        160 + index * 500
      )
    })

    fireEvent.resize(window)
    flushScheduledTimers()

    expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(2)
  })

  test('keeps message navigation marker spacing fixed when the rail overflows', () => {
    const userMessages = Array.from({ length: 12 }, (_, index) => ({
      id: `overflow-user-${index + 1}`,
      role: 'user' as const,
      content: `第 ${index + 1} 条用户需求`,
      status: 'done' as const,
      createdAt: `2026-05-29T00:00:${String(index).padStart(2, '0')}.000Z`,
    }))

    render(<ScrollableMessageArea messages={userMessages} />)

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 240,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 2200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 0, 240)
    scroller.scrollTo = vi.fn()
    userMessages.forEach((message, index) => {
      mockRect(
        screen.getByText(message.content).closest('[data-message-id]')!,
        80 + index * 140,
        128 + index * 140
      )
    })

    fireEvent.resize(window)
    flushScheduledTimers()

    const navigation = screen.getByTestId('message-turn-navigation')
    const navigationRail = screen.getByTestId('message-turn-navigation-rail')
    const markers = screen.getAllByTestId('message-turn-navigation-marker')
    const markerRows = markers.map(marker => marker.parentElement!)
    const markerTops = markerRows.map(row => Number.parseFloat(row.style.top))

    expect(Number.parseFloat(navigation.style.height)).toBeCloseTo(120.444)
    expect(navigation).toHaveStyle({ maxHeight: 'calc(100% - 48px)' })
    expect(navigationRail).toHaveStyle({
      overflowY: 'auto',
    })
    expect(markerTops[1] - markerTops[0]).toBeCloseTo(10.222)
    expect(markerTops[markerTops.length - 1] - markerTops[markerTops.length - 2]).toBeCloseTo(
      10.222
    )
    expect(Number.parseFloat(markerRows[0].style.height)).toBeCloseTo(10.222)
  })

  test('calculates turn navigation anchors with a single message-anchor query', () => {
    const messages = Array.from({ length: 12 }).flatMap((_, index) => [
      {
        id: `bulk-user-${index}`,
        role: 'user' as const,
        content: `bulk user ${index}`,
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:00.000Z',
      },
      {
        id: `bulk-assistant-${index}`,
        role: 'assistant' as const,
        content: `bulk assistant ${index}`,
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:01.000Z',
      },
    ])
    const querySelectorAllSpy = vi.spyOn(HTMLElement.prototype, 'querySelectorAll')

    render(<ScrollableMessageArea messages={messages} />)

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 300,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 4000,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 0, 300)
    scroller.scrollTo = vi.fn()
    for (let index = 0; index < 12; index += 1) {
      mockRect(screen.getByText(`bulk user ${index}`).closest('[data-message-id]')!, 120, 180)
    }

    querySelectorAllSpy.mockClear()
    fireEvent.resize(window)
    flushScheduledTimers()

    const messageAnchorQueries = querySelectorAllSpy.mock.calls.filter(([selector]) =>
      String(selector).includes('[data-message-id]')
    )
    expect(messageAnchorQueries).toHaveLength(1)

    querySelectorAllSpy.mockRestore()
  })

  test('renders turn navigation before virtualized row styles settle', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'virtualized-user',
            role: 'user',
            content: 'Virtualized request',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
          {
            id: 'virtualized-assistant',
            role: 'assistant',
            content: 'Virtualized response',
            status: 'done',
            createdAt: '2026-05-29T00:00:01.000Z',
          },
          {
            id: 'virtualized-user-2',
            role: 'user',
            content: 'Second virtualized request',
            status: 'done',
            createdAt: '2026-05-29T00:00:02.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 300,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 0, 300)
    fireEvent.resize(window)
    flushScheduledTimers()

    expect(screen.getAllByTestId('message-turn-navigation-marker')).toHaveLength(2)
  })

  test('activates a turn from mounted assistant rows when user rows are virtualized', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const contentRef = createRef<HTMLDivElement>()
    const messages = [
      {
        id: 'virtual-active-user-1',
        role: 'user' as const,
        content: 'First request',
        status: 'done' as const,
        createdAt: '2026-07-31T00:00:00.000Z',
        runtimeMessageIndex: 100,
      },
      {
        id: 'virtual-active-assistant-1',
        role: 'assistant' as const,
        content: 'First response',
        status: 'done' as const,
        createdAt: '2026-07-31T00:00:01.000Z',
        runtimeMessageIndex: 101,
      },
      {
        id: 'virtual-active-user-2',
        role: 'user' as const,
        content: 'Second request',
        status: 'done' as const,
        createdAt: '2026-07-31T00:00:02.000Z',
        runtimeMessageIndex: 102,
      },
      {
        id: 'virtual-active-assistant-2',
        role: 'assistant' as const,
        content: 'Long second response',
        status: 'done' as const,
        createdAt: '2026-07-31T00:00:03.000Z',
        runtimeMessageIndex: 103,
      },
      {
        id: 'virtual-active-user-3',
        role: 'user' as const,
        content: 'Third request',
        status: 'done' as const,
        createdAt: '2026-07-31T00:00:04.000Z',
        runtimeMessageIndex: 104,
      },
      {
        id: 'virtual-active-unindexed-assistant',
        role: 'assistant' as const,
        content: 'Transient response without a transcript index',
        status: 'done' as const,
        createdAt: '2026-07-31T00:00:05.000Z',
      },
    ]

    render(
      <div ref={scrollRef}>
        <div ref={contentRef}>
          <div data-message-id="virtual-active-assistant-1">First response</div>
          <div data-message-id="virtual-active-assistant-2">Long second response</div>
          <div data-message-id="virtual-active-unindexed-assistant">
            Transient response without a transcript index
          </div>
        </div>
        <MessageTurnNavigation messages={messages} scrollRef={scrollRef} contentRef={contentRef} />
      </div>
    )

    const scroller = scrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 4_000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 2_800,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 0, 300)
    mockRect(screen.getByText('First response'), -500, -400)
    mockRect(screen.getByText('Long second response'), 40, 1_200)
    mockRect(screen.getByText('Transient response without a transcript index'), 1_300, 1_400)

    fireEvent.resize(window)
    flushScheduledTimers()

    const markers = screen.getAllByTestId('message-turn-navigation-marker')
    expect(markers).toHaveLength(3)
    expect(markers[0]).toHaveAttribute('data-active', 'false')
    expect(markers[1]).toHaveAttribute('data-active', 'true')
    expect(markers[2]).toHaveAttribute('data-active', 'false')

    scroller.scrollTop = 2_900
    fireEvent.scroll(scroller)

    expect(markers[1]).toHaveAttribute('data-active', 'true')
  })

  test('keeps the active turn stable until streaming layout measurements catch up', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const contentRef = createRef<HTMLDivElement>()
    const messages = [
      {
        id: 'stream-layout-user-1',
        role: 'user' as const,
        content: 'First request',
        status: 'done' as const,
        createdAt: '2026-09-03T00:00:00.000Z',
      },
      {
        id: 'stream-layout-assistant-1',
        role: 'assistant' as const,
        content: 'First response',
        status: 'done' as const,
        createdAt: '2026-09-03T00:00:01.000Z',
      },
      {
        id: 'stream-layout-user-2',
        role: 'user' as const,
        content: 'Streaming request',
        status: 'done' as const,
        createdAt: '2026-09-03T00:00:02.000Z',
      },
      {
        id: 'stream-layout-assistant-2',
        role: 'assistant' as const,
        content: 'Streaming response',
        status: 'streaming' as const,
        createdAt: '2026-09-03T00:00:03.000Z',
      },
    ]

    render(
      <div ref={scrollRef}>
        <div ref={contentRef}>
          {messages.map(message => (
            <div key={message.id} data-message-id={message.id}>
              {message.content}
            </div>
          ))}
        </div>
        <MessageTurnNavigation messages={messages} scrollRef={scrollRef} contentRef={contentRef} />
      </div>
    )

    const scroller = scrollRef.current!
    let scrollHeight = 1_000
    Object.defineProperties(scroller, {
      clientHeight: { value: 300, configurable: true },
      scrollHeight: { get: () => scrollHeight, configurable: true },
      scrollTop: { value: 700, writable: true, configurable: true },
    })
    mockRect(scroller, 0, 300)
    mockScrollRelativeRect(screen.getByText('First request'), scroller, 0, 60)
    mockScrollRelativeRect(screen.getByText('First response'), scroller, 60, 440)
    mockScrollRelativeRect(screen.getByText('Streaming request'), scroller, 750, 50)
    const streamingResponse = screen.getByText('Streaming response')
    mockScrollRelativeRect(streamingResponse, scroller, 800, 200)

    fireEvent.resize(window)
    flushScheduledTimers()

    const markers = screen.getAllByTestId('message-turn-navigation-marker')
    expect(markers[1]).toHaveAttribute('data-active', 'true')

    scrollHeight = 1_400
    mockScrollRelativeRect(streamingResponse, scroller, 800, 600)
    scroller.scrollTop = 1_100
    fireEvent.scroll(scroller)

    expect(markers[1]).toHaveAttribute('data-active', 'true')
    flushScheduledTimers()
    expect(markers[1]).toHaveAttribute('data-active', 'true')
  })

  test('activates a turn from a page-leading assistant', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const contentRef = createRef<HTMLDivElement>()

    render(
      <div ref={scrollRef}>
        <div ref={contentRef}>
          <div data-message-id="boundary-assistant">Boundary response</div>
        </div>
        <MessageTurnNavigation
          messages={[
            {
              id: 'boundary-assistant',
              role: 'assistant',
              content: 'Boundary response',
              status: 'done',
              createdAt: '2026-07-31T00:00:11.000Z',
            },
            {
              id: 'next-user',
              role: 'user',
              content: 'Next request',
              status: 'done',
              createdAt: '2026-07-31T00:00:12.000Z',
              runtimeMessageIndex: 12,
            },
            {
              id: 'next-assistant',
              role: 'assistant',
              content: 'Next response',
              status: 'done',
              createdAt: '2026-07-31T00:00:13.000Z',
              runtimeMessageIndex: 13,
            },
          ]}
          turnNavigation={[
            {
              id: 'previous-user',
              turnIndex: 4,
              messageIndex: 8,
              promptPreview: 'Previous request',
              responsePreview: 'Previous response',
            },
            {
              id: 'boundary-user',
              turnIndex: 5,
              messageIndex: 10,
              promptPreview: 'Boundary request',
              responsePreview: 'Boundary response',
            },
            {
              id: 'next-user',
              turnIndex: 6,
              messageIndex: 12,
              promptPreview: 'Next request',
              responsePreview: 'Next response',
            },
          ]}
          scrollRef={scrollRef}
          contentRef={contentRef}
        />
      </div>
    )

    const scroller = scrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 4_000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 2_800,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 0, 300)
    mockRect(screen.getByText('Boundary response'), 40, 1_200)

    fireEvent.resize(window)
    flushScheduledTimers()

    const markers = screen.getAllByTestId('message-turn-navigation-marker')
    expect(markers).toHaveLength(3)
    expect(markers[0]).toHaveAttribute('data-active', 'false')
    expect(markers[1]).toHaveAttribute('data-active', 'true')
    expect(markers[2]).toHaveAttribute('data-active', 'false')
  })

  test('activates every user message visible in the viewport', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'visible-user-1',
            role: 'user',
            content: 'Visible request one',
            status: 'done',
            createdAt: '2026-07-31T00:00:00.000Z',
          },
          {
            id: 'visible-assistant',
            role: 'assistant',
            content: 'Visible response',
            status: 'done',
            createdAt: '2026-07-31T00:00:01.000Z',
          },
          {
            id: 'visible-user-2',
            role: 'user',
            content: 'Visible request two',
            status: 'done',
            createdAt: '2026-07-31T00:00:02.000Z',
          },
          {
            id: 'hidden-user',
            role: 'user',
            content: 'Hidden request',
            status: 'done',
            createdAt: '2026-07-31T00:00:03.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 200,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 0, 300)
    mockRect(screen.getByText('Visible request one').closest('[data-message-id]')!, -20, 80)
    mockRect(screen.getByText('Visible response').closest('[data-message-id]')!, 80, 120)
    mockRect(screen.getByText('Visible request two').closest('[data-message-id]')!, 200, 80)
    mockRect(screen.getByText('Hidden request').closest('[data-message-id]')!, 420, 80)

    fireEvent.resize(window)
    flushScheduledTimers()

    const markers = screen.getAllByTestId('message-turn-navigation-marker')
    expect(markers).toHaveLength(3)
    expect(markers[0]).toHaveAttribute('data-active', 'true')
    expect(markers[1]).toHaveAttribute('data-active', 'true')
    expect(markers[2]).toHaveAttribute('data-active', 'false')
  })

  test('tracks the active turn when the loaded page contains only its assistant response', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const contentRef = createRef<HTMLDivElement>()
    const messages = projectRuntimeConversationTurns([
      {
        id: 'assistant-only-turn',
        runtimeMessageIndex: 10,
        items: [
          {
            id: 'assistant-only-item',
            type: 'assistant_text',
            content: 'Only the response is loaded on this page',
            createdAt: '2026-08-09T00:00:00.000Z',
          },
        ],
        status: 'done',
      },
    ])

    render(
      <div ref={scrollRef}>
        <div ref={contentRef}>
          <div data-message-id={messages[0].id}>Only the response is loaded on this page</div>
        </div>
        <MessageTurnNavigation
          messages={messages}
          turnNavigation={[
            {
              id: 'previous-user',
              turnIndex: 4,
              messageIndex: 8,
              promptPreview: 'Previous request',
              responsePreview: 'Previous response',
            },
            {
              id: 'assistant-only-user',
              turnIndex: 5,
              messageIndex: 10,
              promptPreview: 'Request for the loaded response',
              responsePreview: 'Only the response is loaded on this page',
            },
            {
              id: 'next-user',
              turnIndex: 6,
              messageIndex: 12,
              promptPreview: 'Next request',
              responsePreview: 'Next response',
            },
          ]}
          scrollRef={scrollRef}
          contentRef={contentRef}
        />
      </div>
    )

    const scroller = scrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 4_000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 2_800,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 0, 300)
    mockRect(screen.getByText('Only the response is loaded on this page'), 40, 1_200)

    fireEvent.resize(window)
    flushScheduledTimers()

    const markers = screen.getAllByTestId('message-turn-navigation-marker')
    expect(markers).toHaveLength(3)
    expect(markers[0]).toHaveAttribute('data-active', 'false')
    expect(markers[1]).toHaveAttribute('data-active', 'true')
    expect(markers[2]).toHaveAttribute('data-active', 'false')
  })

  test('clicks a message navigation marker to jump to that user message', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'jump-user-1',
            role: 'user',
            content: '先前需求',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
          {
            id: 'jump-assistant-1',
            role: 'assistant',
            content: '先前回复',
            status: 'done',
            createdAt: '2026-05-29T00:00:01.000Z',
          },
          {
            id: 'jump-user-2',
            role: 'user',
            content: '需要跳转的需求',
            status: 'done',
            createdAt: '2026-05-29T00:00:02.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 300,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number') scroller.scrollTop = top
    })
    mockRect(scroller, 0, 300)
    mockRect(screen.getByText('先前需求').closest('[data-message-id]')!, 120, 180)
    const targetAnchor = screen.getByText('需要跳转的需求').closest('[data-message-id]')!
    let targetDocumentTop = 620
    targetAnchor.getBoundingClientRect = vi.fn(() => {
      const top = targetDocumentTop - scroller.scrollTop
      return {
        top,
        bottom: top + 60,
        left: 0,
        right: 320,
        width: 320,
        height: 60,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect
    })

    fireEvent.resize(window)
    flushScheduledTimers()
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[1])

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: 524,
      behavior: 'smooth',
    })

    targetDocumentTop = 720
    act(() => vi.advanceTimersByTime(80))
    expect(scroller.scrollTop).toBe(624)
  })

  test('keeps turn navigation in control while a clicked target settles', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    const originalResizeObserver = globalThis.ResizeObserver

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const messages = [
      {
        id: 'settle-user-1',
        role: 'user' as const,
        content: '第一条需求',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:00.000Z',
      },
      {
        id: 'settle-assistant-1',
        role: 'assistant' as const,
        content: '很长的回复',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:01.000Z',
      },
      {
        id: 'settle-user-2',
        role: 'user' as const,
        content: '最新需求',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:02.000Z',
      },
    ]
    render(<ScrollableMessageArea conversationKey="navigation-settle" messages={messages} />)

    const scroller = screen.getByTestId('chat-message-scroll-area')
    const content = screen.getByTestId('chat-message-scroll-area-content')
    const firstMessageAnchor = screen.getByText('第一条需求').closest('[data-message-id]')!
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', { value: 700, writable: true, configurable: true })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number') scroller.scrollTop = top
    })
    mockRect(scroller, 0, 300)
    mockScrollRelativeRect(firstMessageAnchor, scroller, 120, 60)

    fireEvent.resize(window)
    flushScheduledTimers()
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
    expect(scroller.scrollTop).toBe(24)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    fireEvent.scroll(scroller)
    expect(scroller.scrollTo).not.toHaveBeenCalled()

    Object.defineProperty(scroller, 'scrollHeight', { value: 1600, configurable: true })
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })
    expect(scroller.scrollTop).toBe(24)

    mockScrollRelativeRect(firstMessageAnchor, scroller, 180, 60)
    act(() => vi.advanceTimersByTime(80))
    expect(scroller.scrollTop).toBe(84)
    act(() => vi.runOnlyPendingTimers())
    expect(scroller.scrollTop).toBe(84)
    expect(getConversationScrollSnapshot('navigation-settle')).toEqual({
      distanceFromBottomPx: 1216,
      pinnedToBottom: false,
    })
    expect(content).toBeInTheDocument()
    vi.stubGlobal('ResizeObserver', originalResizeObserver)
  })

  test('does not save stale turn navigation into a newly opened conversation', () => {
    const messagesA = [
      {
        id: 'stale-navigation-user-1',
        role: 'user' as const,
        content: '旧会话第一条需求',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:00.000Z',
      },
      {
        id: 'stale-navigation-assistant-1',
        role: 'assistant' as const,
        content: '旧会话回复',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:01.000Z',
      },
      {
        id: 'stale-navigation-user-2',
        role: 'user' as const,
        content: '旧会话最新需求',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:02.000Z',
      },
    ]
    const messagesB = [
      {
        id: 'stale-navigation-new-conversation',
        role: 'assistant' as const,
        content: '新会话内容',
        status: 'done' as const,
        createdAt: '2026-05-29T00:01:00.000Z',
      },
    ]
    cacheConversationScrollSnapshot('stale-navigation-b', {
      distanceFromBottomPx: 420,
      pinnedToBottom: false,
    })
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="stale-navigation-a" messages={messagesA} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    const firstMessageAnchor = screen.getByText('旧会话第一条需求').closest('[data-message-id]')!
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 700,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number') scroller.scrollTop = top
    })
    mockRect(scroller, 0, 300)
    mockScrollRelativeRect(firstMessageAnchor, scroller, 120, 60)

    fireEvent.resize(window)
    flushScheduledTimers()
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])
    rerender(<ScrollableMessageArea conversationKey="stale-navigation-b" messages={messagesB} />)
    Object.defineProperty(scroller, 'scrollTop', {
      value: 480,
      writable: true,
      configurable: true,
    })
    act(() => vi.runOnlyPendingTimers())

    expect(getConversationScrollSnapshot('stale-navigation-b')).toEqual({
      distanceFromBottomPx: 420,
      pinnedToBottom: false,
    })
  })

  test('jumps to the resolved client message id after loading an older turn', async () => {
    let resolveLoad: (() => void) | undefined
    const onLoadTurnNavigationItem = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveLoad = resolve
        })
    )
    const latestMessage = {
      id: 'client-latest-user',
      role: 'user' as const,
      content: '最新需求',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:02.000Z',
      runtimeMessageIndex: 2,
    }
    const turnNavigation = [
      {
        id: 'runtime-older-user',
        turnIndex: 0,
        messageIndex: 0,
        cursor: 'offset:0',
        promptPreview: '历史需求',
        responsePreview: '历史回复',
      },
      {
        id: 'runtime-latest-user',
        turnIndex: 1,
        messageIndex: 2,
        cursor: 'offset:2',
        promptPreview: '最新需求',
        responsePreview: '',
      },
    ]
    const { rerender } = render(
      <ScrollableMessageArea
        messages={[latestMessage]}
        turnNavigation={turnNavigation}
        onLoadTurnNavigationItem={onLoadTurnNavigationItem}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 500,
      writable: true,
      configurable: true,
    })
    mockRect(scroller, 0, 300)
    mockRect(screen.getByText('最新需求').closest('[data-message-id]')!, 620, 680)

    fireEvent.resize(window)
    flushScheduledTimers()
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[0])

    expect(onLoadTurnNavigationItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'runtime-older-user', messageIndex: 0 })
    )
    expect(screen.getByTestId('message-turn-navigation-loading')).toBeInTheDocument()

    rerender(
      <ScrollableMessageArea
        messages={[
          {
            id: 'client-older-user',
            role: 'user',
            content: '历史需求',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
            runtimeMessageIndex: 0,
          },
          latestMessage,
        ]}
        turnNavigation={turnNavigation}
        onLoadTurnNavigationItem={onLoadTurnNavigationItem}
      />
    )

    await act(async () => Promise.resolve())

    expect(screen.getAllByText('历史需求')).toHaveLength(2)
    expect(screen.queryByTestId('message-turn-navigation-loading')).not.toBeInTheDocument()

    await act(async () => {
      resolveLoad?.()
      await Promise.resolve()
    })
  })

  test('loads an unresolved transcript gap once without taking over message layout', async () => {
    const observerCallbacks: IntersectionObserverCallback[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class IntersectionObserverMock {
        constructor(callback: IntersectionObserverCallback) {
          observerCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
    let resolveGapLoad: (() => void) | undefined
    const onLoadTranscriptGap = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveGapLoad = resolve
        })
    )

    render(
      <ScrollableMessageArea
        conversationKey="unresolved-transcript-gap"
        messages={[
          {
            id: 'before-gap',
            role: 'user',
            content: '触发模型报错',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
            runtimeMessageIndex: 0,
          },
          {
            id: 'after-gap',
            role: 'user',
            content: '报错后的下一条消息',
            status: 'done',
            createdAt: '2026-05-29T00:00:02.000Z',
            runtimeMessageIndex: 2,
          },
        ]}
        onLoadTranscriptGap={onLoadTranscriptGap}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    const firstMessage = screen.getByText('触发模型报错').closest('[data-message-id]')!
    expect(observerCallbacks).toHaveLength(1)

    await act(async () => {
      observerCallbacks[0](
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })

    expect(onLoadTranscriptGap).toHaveBeenCalledTimes(1)
    expect(onLoadTranscriptGap).toHaveBeenCalledWith({ start: 1, end: 2 })
    expect(
      screen.getByTestId('runtime-transcript-gap-marker').querySelector('button')
    ).toBeDisabled()
    expect(screen.queryByTestId('message-turn-navigation-loading')).not.toBeInTheDocument()
    expect(scroller).not.toHaveClass('[overflow-anchor:none]')
    expect(firstMessage).toHaveClass('[content-visibility:auto]')

    await act(async () => {
      resolveGapLoad?.()
      await Promise.resolve()
    })
    expect(observerCallbacks).toHaveLength(2)

    await act(async () => {
      observerCallbacks[1](
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })

    expect(onLoadTranscriptGap).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('runtime-transcript-gap-marker').querySelector('button')!)
    expect(onLoadTranscriptGap).toHaveBeenCalledTimes(2)
  })

  test('does not render a gap for transcript indexes already covered by a loaded page', () => {
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'retried-user',
            role: 'user',
            content: '重试后的请求',
            status: 'done',
            createdAt: '2026-07-27T00:00:00.000Z',
            runtimeMessageIndex: 0,
          },
          {
            id: 'successful-retry',
            role: 'assistant',
            content: '最终成功响应',
            status: 'done',
            createdAt: '2026-07-27T00:00:03.000Z',
            runtimeMessageIndex: 3,
          },
        ]}
        loadedTranscriptRanges={[{ start: 0, end: 4 }]}
        onLoadTranscriptGap={vi.fn()}
      />
    )

    expect(screen.queryByTestId('runtime-transcript-gap-marker')).not.toBeInTheDocument()
  })

  test('loads only the uncovered part between partially loaded transcript ranges', () => {
    const onLoadTranscriptGap = vi.fn()

    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'before-partial-gap',
            role: 'user',
            content: '缺口之前',
            status: 'done',
            createdAt: '2026-07-27T00:00:00.000Z',
            runtimeMessageIndex: 0,
          },
          {
            id: 'after-partial-gap',
            role: 'assistant',
            content: '缺口之后',
            status: 'done',
            createdAt: '2026-07-27T00:00:05.000Z',
            runtimeMessageIndex: 5,
          },
        ]}
        loadedTranscriptRanges={[
          { start: 0, end: 3 },
          { start: 4, end: 6 },
        ]}
        onLoadTranscriptGap={onLoadTranscriptGap}
      />
    )

    fireEvent.click(screen.getByTestId('runtime-transcript-gap-marker').querySelector('button')!)

    expect(onLoadTranscriptGap).toHaveBeenCalledWith({ start: 3, end: 4 })
  })

  test('pins the conversation to the bottom after opening a chat', () => {
    render(
      <ScrollableMessageArea
        conversationKey={1}
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

    const scroller = screen.getByTestId('chat-message-scroll-area')
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

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 600,
      behavior: 'auto',
    })
  })

  test('keeps following the bottom while an unopened conversation is being measured', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )

    render(
      <ScrollableMessageArea
        conversationKey="unopened-measuring"
        messages={[
          {
            id: '1',
            role: 'assistant',
            content: '后台完成的长回复',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
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
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    act(() => {
      vi.advanceTimersByTime(0)
    })
    scrollHeight = 900
    fireEvent.scroll(scroller)
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 900,
      behavior: 'auto',
    })
  })

  test('keeps an unopened conversation pinned when the external scroller height changes', () => {
    const resizeObservers: Array<{
      callback: ResizeObserverCallback
      targets: Set<Element>
    }> = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        targets = new Set<Element>()

        constructor(public callback: ResizeObserverCallback) {
          resizeObservers.push(this)
        }

        observe(target: Element) {
          this.targets.add(target)
        }

        disconnect() {}
      }
    )

    const externalScrollRef = createRef<HTMLDivElement>()
    render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="unopened-external-resize"
          externalScrollRef={externalScrollRef}
          messages={[
            {
              id: 'completed-response',
              role: 'assistant',
              content: '后台完成的长回复',
              status: 'done',
              createdAt: '2026-05-29T00:00:00.000Z',
            },
          ]}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    let clientHeight = 600
    const scrollHeight = 1_600
    Object.defineProperty(scroller, 'clientHeight', {
      get: () => clientHeight,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: scrollHeight,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Math.min(Number(top), scrollHeight - clientHeight)
    })

    flushScheduledTimers()
    expect(scroller.scrollTop).toBe(-0)
    fireEvent.scroll(scroller)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    expect(resizeObservers.some(observer => observer.targets.has(scroller))).toBe(true)
    expect(getConversationScrollSnapshot('unopened-external-resize')).toEqual({
      distanceFromBottomPx: 0,
      pinnedToBottom: true,
    })

    clientHeight = 460
    act(() => {
      resizeObservers
        .filter(observer => observer.targets.has(scroller))
        .forEach(observer => observer.callback([], {} as ResizeObserver))
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: -0,
      behavior: 'auto',
    })
    expect(scroller.scrollTop).toBe(-0)
  })

  test('follows the assistant response after latest-user placement stabilizes', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )

    const previousUserMessage = {
      id: 'previous-user',
      role: 'user' as const,
      content: '之前的问题',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const previousAssistantMessage = {
      id: 'previous-assistant',
      role: 'assistant' as const,
      content: '之前的回答',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:01.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea
        conversationKey="latest-user-turn"
        messages={[previousUserMessage, previousAssistantMessage]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
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
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    scrollHeight = 1000
    rerender(
      <ScrollableMessageArea
        conversationKey="latest-user-turn"
        messages={[
          previousUserMessage,
          previousAssistantMessage,
          {
            id: 'latest-user',
            role: 'user',
            content: '请继续处理',
            status: 'done',
            createdAt: '2026-05-29T00:00:02.000Z',
          },
          {
            id: 'latest-assistant',
            role: 'assistant',
            content: '正在处理',
            status: 'streaming',
            createdAt: '2026-05-29T00:00:03.000Z',
          },
        ]}
      />
    )

    flushStreamingFollow()
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 800,
      behavior: 'auto',
    })
    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    scrollHeight = 1600
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })
    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 1400,
      behavior: 'auto',
    })
  })

  test('keeps scrolling through layout measurement when the waiting indicator appears after send', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )

    const previousMessage = {
      id: 'previous-assistant',
      role: 'assistant' as const,
      content: '之前的回答',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const latestUserMessage = {
      id: 'latest-user',
      role: 'user' as const,
      content: '请继续处理',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:01.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="waiting-after-send" messages={[previousMessage]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    let scrollHeight = 600
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    rerender(
      <ScrollableMessageArea
        conversationKey="waiting-after-send"
        messages={[previousMessage, latestUserMessage]}
      />
    )

    scrollHeight = 900
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })
    rerender(
      <ScrollableMessageArea
        conversationKey="waiting-after-send"
        messages={[previousMessage, latestUserMessage]}
        isWaitingForAssistant
      />
    )
    scrollHeight = 1000
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      vi.runOnlyPendingTimers()
    })

    expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument()
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 1000,
      behavior: 'auto',
    })
  })

  test('follows the first assistant response after starting from an empty conversation', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )

    const { rerender } = render(
      <ScrollableMessageArea conversationKey="first-user-turn" messages={[]} />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    let scrollHeight = 200
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    rerender(
      <ScrollableMessageArea
        conversationKey="first-user-turn"
        messages={[
          {
            id: 'first-user',
            role: 'user',
            content: '请处理这个问题',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />
    )

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 200,
      behavior: 'auto',
    })
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    rerender(
      <ScrollableMessageArea
        conversationKey="first-user-turn"
        messages={[
          {
            id: 'first-user',
            role: 'user',
            content: '请处理这个问题',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
          {
            id: 'first-assistant',
            role: 'assistant',
            content: '正在处理',
            status: 'streaming',
            createdAt: '2026-05-29T00:00:01.000Z',
          },
        ]}
      />
    )

    scrollHeight = 1000
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 1000,
      behavior: 'auto',
    })
  })

  test('follows an assistant response that started while auto-scroll was suspended', () => {
    const initialMessages = [
      {
        id: 'suspended-user',
        role: 'user' as const,
        content: '请处理这个问题',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:00.000Z',
      },
    ]
    const assistantMessage = {
      id: 'suspended-assistant',
      role: 'assistant' as const,
      content: '正在处理',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:01.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea
        conversationKey="suspended-assistant-start"
        messages={initialMessages}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 600, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    rerender(
      <ScrollableMessageArea
        conversationKey="suspended-assistant-start"
        messages={[...initialMessages, assistantMessage]}
        autoScrollSuspended
      />
    )
    expect(scroller.scrollTo).not.toHaveBeenCalled()

    rerender(
      <ScrollableMessageArea
        conversationKey="suspended-assistant-start"
        messages={[...initialMessages, assistantMessage]}
      />
    )
    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 400,
      behavior: 'auto',
    })
  })

  test('restores the previous scroll position when reopening a conversation', () => {
    const messageA = {
      id: 'a',
      role: 'assistant' as const,
      content: '会话 A',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageB = {
      id: 'b',
      role: 'assistant' as const,
      content: '会话 B',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="conversation-a" messages={[messageA]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 180.5,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn()

    fireEvent.scroll(scroller)
    rerender(<ScrollableMessageArea conversationKey="conversation-b" messages={[messageB]} />)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    rerender(<ScrollableMessageArea conversationKey="conversation-a" messages={[messageA]} />)

    act(() => {
      vi.advanceTimersByTime(0)
    })
    scroller.scrollTop = 37
    fireEvent.scroll(scroller)
    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 180.5,
      behavior: 'auto',
    })
  })

  test('keeps an unpinned reading position when the restored layout height changes', () => {
    const messageA = {
      id: 'height-change-a',
      role: 'assistant' as const,
      content: '会话 A 的长内容',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageB = {
      id: 'height-change-b',
      role: 'assistant' as const,
      content: '会话 B',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:01.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="height-change-a" messages={[messageA]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 300,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    rerender(<ScrollableMessageArea conversationKey="height-change-b" messages={[messageB]} />)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1400, configurable: true })
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    rerender(<ScrollableMessageArea conversationKey="height-change-a" messages={[messageA]} />)
    flushScheduledTimers()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 500,
      behavior: 'auto',
    })
  })

  test('does not overwrite a saved reading position with a restore-generated scroll event', () => {
    const messageA = {
      id: 'transient-layout-a',
      role: 'assistant' as const,
      content: '会话 A 的长内容',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageB = {
      id: 'transient-layout-b',
      role: 'assistant' as const,
      content: '会话 B',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:01.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="transient-layout-a" messages={[messageA]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 300,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    rerender(<ScrollableMessageArea conversationKey="transient-layout-b" messages={[messageB]} />)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    scroller.scrollTop = 0
    rerender(<ScrollableMessageArea conversationKey="transient-layout-a" messages={[messageA]} />)
    scroller.scrollTop = 850
    fireEvent.scroll(scroller)

    flushScheduledTimers()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 300,
      behavior: 'auto',
    })
  })

  test('restores a streaming conversation to its latest bottom after switching back', () => {
    const streamingMessage = {
      id: 'streaming-a',
      role: 'assistant' as const,
      content: '正在处理',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageB = {
      id: 'done-b',
      role: 'assistant' as const,
      content: '会话 B',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="streaming-switch-a" messages={[streamingMessage]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 600, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.scroll(scroller)
    rerender(<ScrollableMessageArea conversationKey="streaming-switch-b" messages={[messageB]} />)
    Object.defineProperty(scroller, 'scrollHeight', { value: 900, configurable: true })
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    rerender(
      <ScrollableMessageArea
        conversationKey="streaming-switch-a"
        messages={[{ ...streamingMessage, content: '正在处理\n\n更多后台流式内容' }]}
      />
    )
    flushScheduledTimers()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 700,
      behavior: 'auto',
    })
    expect(screen.queryByTestId('scroll-to-bottom-button')).not.toBeInTheDocument()
  })

  test('captures a bottom-pinned streaming conversation before its pane unmounts', () => {
    const streamingMessage = {
      id: 'streaming-unmount',
      role: 'assistant' as const,
      content: '正在处理',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { unmount } = render(
      <ScrollableMessageArea
        conversationKey="streaming-unmount-bottom"
        messages={[streamingMessage]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 600, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    })

    unmount()

    expect(getConversationScrollSnapshot('streaming-unmount-bottom')).toEqual({
      distanceFromBottomPx: 0,
      pinnedToBottom: true,
    })
  })

  test('unmounts previously selected conversation DOM while preserving switch-back rendering', () => {
    const messageA = {
      id: 'cached-message-a',
      role: 'assistant' as const,
      content: 'cached conversation a',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageB = {
      id: 'cached-message-b',
      role: 'assistant' as const,
      content: 'cached conversation b',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:01.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="cached-a" messages={[messageA]} />
    )
    const messageElementA = screen.getByText('cached conversation a').closest('[data-message-id]')

    rerender(<ScrollableMessageArea conversationKey="cached-b" messages={[messageB]} />)

    expect(messageElementA?.isConnected).toBe(false)
    expect(screen.getByText('cached conversation b')).toBeInTheDocument()

    rerender(<ScrollableMessageArea conversationKey="cached-a" messages={[messageA]} />)

    const nextMessageElementA = screen
      .getByText('cached conversation a')
      .closest('[data-message-id]')
    expect(nextMessageElementA).not.toBe(messageElementA)
    expect(nextMessageElementA).toBeInTheDocument()
  })

  test('does not read inactive conversation content after switching away', () => {
    let messageAContentReads = 0
    const messageA = {
      id: 'cached-render-message-a',
      role: 'assistant' as const,
      get content() {
        messageAContentReads += 1
        return 'cached render conversation a'
      },
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageB = {
      id: 'cached-render-message-b',
      role: 'assistant' as const,
      content: 'cached render conversation b',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:01.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="cached-render-a" messages={[messageA]} />
    )

    expect(screen.getByText('cached render conversation a')).toBeInTheDocument()
    messageAContentReads = 0

    rerender(<ScrollableMessageArea conversationKey="cached-render-b" messages={[messageB]} />)

    expect(screen.getByText('cached render conversation b')).toBeInTheDocument()
    expect(messageAContentReads).toBe(0)
  })

  test('does not overwrite a saved position while a reopened conversation is loading', () => {
    const messageA = {
      id: 'a-loading-restore',
      role: 'assistant' as const,
      content: '会话 A',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageB = {
      id: 'b-loading-restore',
      role: 'assistant' as const,
      content: '会话 B',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="conversation-loading-a" messages={[messageA]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 180,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    rerender(
      <ScrollableMessageArea conversationKey="conversation-loading-b" messages={[messageB]} />
    )
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    scroller.scrollTop = 0
    rerender(
      <ScrollableMessageArea conversationKey="conversation-loading-a" messages={[]} loading />
    )
    rerender(
      <ScrollableMessageArea conversationKey="conversation-loading-a" messages={[messageA]} />
    )

    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 180,
      behavior: 'auto',
    })
  })

  test('restores reopened conversations to the saved reading position', () => {
    const messagesA = [
      {
        id: 'anchor-a-intro',
        role: 'assistant' as const,
        content: '会话 A 前置内容',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:00.000Z',
      },
      {
        id: 'anchor-a-target',
        role: 'assistant' as const,
        content: '会话 A 当前阅读内容',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:01.000Z',
      },
      {
        id: 'anchor-a-after',
        role: 'assistant' as const,
        content: '会话 A 后续内容',
        status: 'done' as const,
        createdAt: '2026-05-29T00:00:02.000Z',
      },
    ]
    const messageB = {
      id: 'anchor-b',
      role: 'assistant' as const,
      content: '会话 B',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="conversation-anchor-a" messages={messagesA} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1200,
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
    mockRect(scroller, 100, 300)
    mockRect(screen.getByText('会话 A 前置内容').closest('[data-message-id]')!, -160, -20)
    mockRect(screen.getByText('会话 A 当前阅读内容').closest('[data-message-id]')!, 80, 220)
    mockRect(screen.getByText('会话 A 后续内容').closest('[data-message-id]')!, 240, 360)

    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    rerender(
      <ScrollableMessageArea conversationKey="conversation-anchor-b" messages={[messageB]} />
    )
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1400,
      configurable: true,
    })
    scroller.scrollTop = 0
    rerender(<ScrollableMessageArea conversationKey="conversation-anchor-a" messages={messagesA} />)
    mockRect(scroller, 100, 300)
    mockScrollRelativeRect(
      screen.getByText('会话 A 当前阅读内容').closest('[data-message-id]')!,
      scroller,
      520,
      140
    )

    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 500,
      behavior: 'auto',
    })
  })

  test('restores long conversations to the saved reading position', () => {
    const messageA = {
      id: 'markdown-anchor-message',
      role: 'assistant' as const,
      content: [
        '- 默认配置',
        '- 构建运行',
        '',
        '## 主要功能',
        '',
        '- Node',
        '- Pod',
        '- NodeResourceTopology',
      ].join('\n'),
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageB = {
      id: 'markdown-anchor-b',
      role: 'assistant' as const,
      content: '会话 B',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea
        conversationKey="conversation-markdown-anchor-a"
        messages={[messageA]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1200,
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
    mockRect(scroller, 100, 300)
    mockRect(screen.getByText('默认配置').closest('[data-scroll-anchor]')!, -220, -188)
    mockRect(screen.getByText('构建运行').closest('[data-scroll-anchor]')!, -170, -138)
    mockRect(screen.getByText('主要功能').closest('[data-scroll-anchor]')!, -78, -42)
    mockRect(screen.getByText('Node').closest('[data-scroll-anchor]')!, 92, 124)
    mockRect(screen.getByText('Pod').closest('[data-scroll-anchor]')!, 140, 172)

    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    rerender(
      <ScrollableMessageArea
        conversationKey="conversation-markdown-anchor-b"
        messages={[messageB]}
      />
    )
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1400,
      configurable: true,
    })
    scroller.scrollTop = 0
    rerender(
      <ScrollableMessageArea
        conversationKey="conversation-markdown-anchor-a"
        messages={[messageA]}
      />
    )
    mockRect(scroller, 100, 300)
    mockScrollRelativeRect(
      screen.getByText('Node').closest('[data-scroll-anchor]')!,
      scroller,
      520,
      32
    )

    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 500,
      behavior: 'auto',
    })
  })

  test('keeps the restored position while reopened conversation content grows', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
    const firstUserMessage = {
      id: 'a-growth-user',
      role: 'user' as const,
      content: '开始会话 A',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageA = {
      id: 'a-growth',
      role: 'assistant' as const,
      content: '会话 A',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:01.000Z',
    }
    const messageB = {
      id: 'b-growth',
      role: 'assistant' as const,
      content: '会话 B',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:02.000Z',
    }
    const messagesA = [firstUserMessage, messageA]
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="conversation-growth-a" messages={messagesA} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 260,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    rerender(
      <ScrollableMessageArea conversationKey="conversation-growth-b" messages={[messageB]} />
    )

    act(() => {
      vi.runOnlyPendingTimers()
    })
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 240,
      configurable: true,
    })
    scroller.scrollTop = 0
    rerender(<ScrollableMessageArea conversationKey="conversation-growth-a" messages={messagesA} />)

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 0,
      behavior: 'auto',
    })

    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1200,
      configurable: true,
    })

    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 260,
      behavior: 'auto',
    })

    rerender(
      <ScrollableMessageArea
        conversationKey="conversation-growth-a"
        messages={[
          ...messagesA,
          {
            id: 'a-growth-user-follow-up',
            role: 'user',
            content: '继续处理',
            status: 'done',
            createdAt: '2026-05-29T00:00:03.000Z',
          },
        ]}
      />
    )
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1400,
      configurable: true,
    })
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 1400,
      behavior: 'auto',
    })
  })

  test('does not pull the user back down when they have scrolled up', () => {
    const initialMessage = {
      id: '1',
      role: 'assistant' as const,
      content: '历史消息',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey={1} messages={[initialMessage]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn()

    fireEvent.scroll(scroller)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    scroller.scrollTop = 0
    fireEvent.wheel(scroller, { deltaY: -80 })
    fireEvent.scroll(scroller)
    rerender(
      <ScrollableMessageArea
        conversationKey={1}
        messages={[
          initialMessage,
          {
            id: '2',
            role: 'assistant',
            content: '追加回复',
            status: 'streaming',
            createdAt: '2026-05-29T00:00:01.000Z',
          },
        ]}
      />
    )

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).not.toHaveBeenCalled()
  })

  test('cancels delayed bottom following as soon as the user scrolls upward', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )

    render(
      <ScrollableMessageArea
        conversationKey="delayed-bottom-follow"
        messages={[
          {
            id: 'delayed-bottom-follow-assistant',
            role: 'assistant',
            content: '回复已完成',
            status: 'done',
            createdAt: '2026-08-18T00:00:00.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    const anchor = screen.getByText('回复已完成').closest('[data-scroll-anchor]')!
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 800,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 600,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })
    mockRect(scroller, 100, 300)
    let anchorTopAtScrollZero = 500
    anchor.getBoundingClientRect = vi.fn(() => {
      const top = anchorTopAtScrollZero - scroller.scrollTop
      return {
        top,
        bottom: top + 800,
        left: 0,
        right: 320,
        width: 320,
        height: 800,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect
    })

    fireEvent.wheel(scroller, { deltaY: -80 })
    scroller.scrollTop = 440
    fireEvent.scroll(scroller)

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).not.toHaveBeenCalled()

    anchorTopAtScrollZero += 120
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })

    expect(scroller.scrollTop).toBe(560)
    expect(anchor.getBoundingClientRect().top).toBe(60)
  })

  test('keeps delayed bottom following for pointer input without scrolling', () => {
    render(
      <ScrollableMessageArea
        conversationKey="pointer-without-scroll"
        messages={[
          {
            id: 'pointer-without-scroll-assistant',
            role: 'assistant',
            content: '回复已完成',
            status: 'done',
            createdAt: '2026-08-18T00:00:00.000Z',
          },
        ]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 800,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 600,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn()

    fireEvent.pointerDown(scroller)

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenCalled()
  })

  test('scrolls to a newly applied guidance message inserted before the assistant continuation', () => {
    const streamingMessage = {
      id: 'guidance-stream',
      role: 'assistant' as const,
      content: '正在处理现有回复',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="guidance-scroll" messages={[streamingMessage]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 800,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 240,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    flushScheduledTimers()
    scroller.scrollTop = 240
    fireEvent.wheel(scroller, { deltaY: -80 })
    fireEvent.scroll(scroller)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 1000,
      configurable: true,
    })

    rerender(
      <ScrollableMessageArea
        conversationKey="guidance-scroll"
        messages={[
          {
            ...streamingMessage,
            id: 'guidance-stream-before',
            status: 'done',
            runtimeGuidanceSplitBefore: true,
          },
          {
            id: 'guidance-user',
            role: 'user',
            content: '请优先修复滚动问题',
            status: 'done',
            createdAt: '2026-05-29T00:00:01.000Z',
            runtimeGuidance: true,
          },
          {
            ...streamingMessage,
            id: 'guidance-stream-after',
            content: '',
            runtimeGuidanceContinuation: true,
          },
        ]}
      />
    )

    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(scroller.scrollTop).toBeGreaterThan(240)
    expect(scroller.scrollTop).toBeLessThan(800)

    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 800,
      behavior: 'auto',
    })
  })

  test('keeps streaming content pinned when the user was already at the bottom', () => {
    const streamingMessage = {
      id: '1',
      role: 'assistant' as const,
      content: '正在处理',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="pinned-stream" messages={[streamingMessage]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn()

    fireEvent.scroll(scroller)
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 800,
      configurable: true,
    })

    rerender(
      <ScrollableMessageArea
        conversationKey="pinned-stream"
        messages={[
          {
            ...streamingMessage,
            content: '正在处理\n\n核心逻辑\n\n更多流式内容',
          },
        ]}
      />
    )

    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 600,
      behavior: 'auto',
    })
  })

  test('keeps streaming content pinned within the bottom pixel tolerance', () => {
    const streamingMessage = {
      id: 'fractional-bottom-stream',
      role: 'assistant' as const,
      content: '正在处理',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea
        conversationKey="fractional-bottom-scroll"
        messages={[streamingMessage]}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 396,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.scroll(scroller)
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 800,
      configurable: true,
    })

    rerender(
      <ScrollableMessageArea
        conversationKey="fractional-bottom-scroll"
        messages={[
          {
            ...streamingMessage,
            content: '正在处理\n\n核心逻辑\n\n更多流式内容',
          },
        ]}
      />
    )

    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 600,
      behavior: 'auto',
    })
    expect(screen.queryByTestId('scroll-to-bottom-button')).not.toBeInTheDocument()
  })

  test('does not follow streaming content after the user scrolls upward near the bottom', () => {
    const streamingMessage = {
      id: 'near-bottom-stream',
      role: 'assistant' as const,
      content: '正在处理',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="near-bottom-scroll" messages={[streamingMessage]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn()

    fireEvent.scroll(scroller)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    scroller.scrollTop = 360
    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 800,
      configurable: true,
    })

    rerender(
      <ScrollableMessageArea
        conversationKey="near-bottom-scroll"
        messages={[
          {
            ...streamingMessage,
            content: '正在处理\n\n核心逻辑\n\n更多流式内容',
          },
        ]}
      />
    )

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).not.toHaveBeenCalled()
  })

  test('resumes streaming follow after the user returns to the bottom', () => {
    const streamingMessage = {
      id: 'resume-stream',
      role: 'assistant' as const,
      content: '正在处理',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="resume-scroll" messages={[streamingMessage]} />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 360,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.wheel(scroller, { deltaY: -80 })
    fireEvent.scroll(scroller)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    scroller.scrollTop = 400
    fireEvent.wheel(scroller, { deltaY: 80 })
    fireEvent.scroll(scroller)
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 800,
      configurable: true,
    })

    rerender(
      <ScrollableMessageArea
        conversationKey="resume-scroll"
        messages={[
          {
            ...streamingMessage,
            content: '正在处理\n\n核心逻辑\n\n更多流式内容',
          },
        ]}
      />
    )

    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 600,
      behavior: 'auto',
    })
  })
})
