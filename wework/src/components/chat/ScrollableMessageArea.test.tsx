import { act, fireEvent, render, screen } from '@testing-library/react'
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
    expect(scroller).toHaveClass('overflow-x-hidden', 'overflow-y-auto')
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
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: 180.5,
      behavior: 'auto',
    })
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

  test('restores reopened conversations relative to the saved message anchor', () => {
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
      top: 440,
      behavior: 'auto',
    })
  })

  test('restores reopened conversations relative to markdown anchors inside long messages', () => {
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
      top: 428,
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
      top: 40,
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
      <ScrollableMessageArea conversationKey={1} messages={[streamingMessage]} />
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
        conversationKey={1}
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
