import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import {
  installScrollTestEnvironment,
  allResizeCallbacks,
  flushObservedLayout,
  fromBottom,
  messageText,
  mockRect,
  flushScheduledTimers,
  flushStreamingFollow,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: streaming', () => {
  installScrollTestEnvironment()

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
      flushObservedLayout()
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
          allResizeCallbacks.add(callback)
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
    const anchor = messageText('回复已完成').closest('[data-scroll-anchor]')!
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
      flushObservedLayout()
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

  test('keeps bottom following for pointer input without scrolling', () => {
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
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    flushScheduledTimers()
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 800, behavior: 'auto' })
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
      flushObservedLayout()
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
      top: fromBottom(scroller, 0),
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
      top: fromBottom(scroller, 0),
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
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).not.toHaveBeenCalled()
  })
})
