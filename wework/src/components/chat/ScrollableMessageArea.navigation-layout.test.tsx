import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef, useRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { MessageTurnNavigation } from './MessageTurnNavigation'
import {
  installScrollTestEnvironment,
  messageText,
  mockRect,
  flushScheduledTimers,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: navigation-layout', () => {
  installScrollTestEnvironment()

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
    mockRect(messageText('第一条用户需求').closest('[data-message-id]')!, 120, 180)
    mockRect(messageText('第二条用户需求').closest('[data-message-id]')!, 620, 680)

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
        messageText(message.content).closest('[data-message-id]')!,
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
              node.dataset.scrollOrigin = 'top'
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
    mockRect(messageText('第一条回退消息').closest('[data-message-id]')!, 120, 180)
    mockRect(messageText('第二条回退消息').closest('[data-message-id]')!, 620, 680)

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
        messageText(message.content).closest('[data-message-id]')!,
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
      mockRect(messageText(`bulk user ${index}`).closest('[data-message-id]')!, 120, 180)
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
})
