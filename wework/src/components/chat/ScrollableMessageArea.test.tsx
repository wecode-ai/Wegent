import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'

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

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 600,
      behavior: 'smooth',
    })
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

  test('keeps distance from bottom when content reflows after a width change', () => {
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
      const message = screen.getByText('正在阅读的长消息').closest('[data-message-id]')!
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
      mockScrollRelativeRect(message, scroller, 380, 160)

      fireEvent.wheel(scroller, { deltaY: -80 })
      fireEvent.scroll(scroller)
      ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      mockScrollRelativeRect(message, scroller, 620, 280)
      act(() => {
        resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      })

      expect(scroller.scrollTo).toHaveBeenLastCalledWith({
        top: 300,
        behavior: 'auto',
      })
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
    }
  })

  test('keeps distance from bottom while a tall message reflows', () => {
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
          conversationKey="tall-width-reflow"
          messages={[
            {
              id: 'tall-width-reflow-message',
              role: 'assistant',
              content: '超长段落',
              status: 'done',
              createdAt: '2026-05-29T00:00:00.000Z',
            },
          ]}
        />
      )

      const scroller = screen.getByTestId('chat-message-scroll-area')
      const message = screen.getByText('超长段落').closest('[data-message-id]')!
      Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
      Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true })
      Object.defineProperty(scroller, 'scrollTop', {
        value: 500,
        writable: true,
        configurable: true,
      })
      scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
        scroller.scrollTop = Number(top)
      })
      mockRect(scroller, 100, 300)
      mockScrollRelativeRect(message, scroller, 100, 800)

      fireEvent.wheel(scroller, { deltaY: -80 })
      fireEvent.scroll(scroller)
      ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      mockScrollRelativeRect(message, scroller, 100, 1200)
      act(() => {
        resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      })

      expect(scroller.scrollTo).toHaveBeenLastCalledWith({
        top: 500,
        behavior: 'auto',
      })
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
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
      value: 320,
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
      top: 320,
      behavior: 'auto',
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
              '第二条用户需求',
            ].join('\n'),
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

    Object.defineProperty(scroller, 'scrollHeight', { value: 1600, configurable: true })
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
    })
    expect(scroller.scrollTop).toBe(24)

    mockScrollRelativeRect(firstMessageAnchor, scroller, 180, 60)
    act(() => vi.advanceTimersByTime(80))
    expect(scroller.scrollTop).toBe(84)
    expect(content).toBeInTheDocument()
    vi.stubGlobal('ResizeObserver', originalResizeObserver)
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
    vi.unstubAllGlobals()
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
    vi.unstubAllGlobals()
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
    flushScheduledTimers()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 180.5,
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

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 180,
      behavior: 'auto',
    })
  })

  test('restores reopened conversations by saved distance from bottom', () => {
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

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 500,
      behavior: 'auto',
    })
  })

  test('restores long conversations by saved distance from bottom', () => {
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

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 500,
      behavior: 'auto',
    })
  })

  test('keeps the restored position while reopened conversation content grows', () => {
    const messageA = {
      id: 'a-growth',
      role: 'assistant' as const,
      content: '会话 A',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const messageB = {
      id: 'b-growth',
      role: 'assistant' as const,
      content: '会话 B',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="conversation-growth-a" messages={[messageA]} />
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
    rerender(
      <ScrollableMessageArea conversationKey="conversation-growth-a" messages={[messageA]} />
    )

    act(() => {
      vi.advanceTimersByTime(0)
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
      vi.advanceTimersByTime(50)
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 260,
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
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn()

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

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 800,
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

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 800,
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
    fireEvent.wheel(scroller, { deltaY: -80 })
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

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 800,
      behavior: 'auto',
    })
  })
})
