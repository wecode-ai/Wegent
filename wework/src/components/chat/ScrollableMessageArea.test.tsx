import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'

describe('ScrollableMessageArea', () => {
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn>
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0)
        return 1
      })
    cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})
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
      />,
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
      />,
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

  test('does not pull the user back down when they have scrolled up', () => {
    const initialMessage = {
      id: '1',
      role: 'assistant' as const,
      content: '历史消息',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <ScrollableMessageArea conversationKey={1} messages={[initialMessage]} />,
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
      />,
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
      <ScrollableMessageArea conversationKey={1} messages={[streamingMessage]} />,
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
      />,
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
