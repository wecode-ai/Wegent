import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { MessageTurnNavigation } from './MessageTurnNavigation'
import { projectRuntimeConversationTurns } from '@/features/workbench/runtimeConversationTurns'
import {
  installScrollTestEnvironment,
  allResizeCallbacks,
  messageText,
  mockRect,
  mockScrollRelativeRect,
  flushScheduledTimers,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: navigation-visibility', () => {
  installScrollTestEnvironment()

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
        turnId: 'virtual-active-turn-1',
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
        turnId: 'virtual-active-turn-2',
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
        turnId: 'virtual-active-turn-3',
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
        <MessageTurnNavigation
          messages={messages}
          turnNavigation={[
            {
              id: 'virtual-active-turn-1',
              turnId: 'virtual-active-turn-1',
              turnIndex: 0,
              messageIndex: 0,
              promptPreview: '',
            },
            {
              id: 'virtual-active-turn-2',
              turnId: 'virtual-active-turn-2',
              turnIndex: 1,
              messageIndex: 1,
              promptPreview: '',
            },
            {
              id: 'virtual-active-turn-3',
              turnId: 'virtual-active-turn-3',
              turnIndex: 2,
              messageIndex: 2,
              promptPreview: '',
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
    mockRect(messageText('First response'), -500, -400)
    mockRect(messageText('Long second response'), 40, 1_200)
    mockRect(messageText('Transient response without a transcript index'), 1_300, 1_400)

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
    mockScrollRelativeRect(messageText('First request'), scroller, 0, 60)
    mockScrollRelativeRect(messageText('First response'), scroller, 60, 440)
    mockScrollRelativeRect(messageText('Streaming request'), scroller, 750, 50)
    const streamingResponse = messageText('Streaming response')
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
    mockRect(messageText('Boundary response'), 40, 1_200)

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
    mockRect(messageText('Visible request one').closest('[data-message-id]')!, -20, 80)
    mockRect(messageText('Visible response').closest('[data-message-id]')!, 80, 120)
    mockRect(messageText('Visible request two').closest('[data-message-id]')!, 200, 80)
    mockRect(messageText('Hidden request').closest('[data-message-id]')!, 420, 80)

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
    mockRect(messageText('Only the response is loaded on this page'), 40, 1_200)

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
    mockRect(messageText('先前需求').closest('[data-message-id]')!, 120, 180)
    const targetAnchor = messageText('需要跳转的需求').closest('[data-message-id]')!
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
    act(() => {
      for (const callback of [...allResizeCallbacks]) callback([], {} as ResizeObserver)
    })
    expect(scroller.scrollTop).toBe(624)
  })

  test('falls back to message indexes when navigation turn ids are unavailable locally', () => {
    const onLoadTurnNavigationItem = vi.fn()
    render(
      <ScrollableMessageArea
        messages={[
          {
            id: 'fallback-user-1',
            role: 'user',
            content: '已加载的第一条需求',
            status: 'done',
            createdAt: '2026-09-13T00:00:00.000Z',
            runtimeMessageIndex: 0,
          },
          {
            id: 'fallback-user-2',
            role: 'user',
            content: '已加载的第二条需求',
            status: 'done',
            createdAt: '2026-09-13T00:00:01.000Z',
            runtimeMessageIndex: 2,
          },
        ]}
        turnNavigation={[
          {
            id: 'runtime-turn-1',
            turnId: 'provider-turn-1',
            turnIndex: 0,
            messageIndex: 0,
            cursor: 'cursor:0',
            promptPreview: '已加载的第一条需求',
            responsePreview: '',
          },
          {
            id: 'runtime-turn-2',
            turnId: 'provider-turn-2',
            turnIndex: 1,
            messageIndex: 2,
            cursor: 'cursor:2',
            promptPreview: '已加载的第二条需求',
            responsePreview: '',
          },
        ]}
        onLoadTurnNavigationItem={onLoadTurnNavigationItem}
      />
    )

    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperties(scroller, {
      clientHeight: { value: 300, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number') scroller.scrollTop = top
    })
    mockRect(scroller, 0, 300)
    mockRect(messageText('已加载的第一条需求').closest('[data-message-id]')!, 120, 180)
    mockRect(messageText('已加载的第二条需求').closest('[data-message-id]')!, 620, 680)

    fireEvent.resize(window)
    flushScheduledTimers()
    scroller.scrollTop = 0
    vi.mocked(scroller.scrollTo).mockClear()
    fireEvent.click(screen.getAllByTestId('message-turn-navigation-marker')[1])

    expect(onLoadTurnNavigationItem).not.toHaveBeenCalled()
    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: 524,
      behavior: 'smooth',
    })
  })
})
