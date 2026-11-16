import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { getConversationScrollSnapshot } from '@/features/workbench/runtimeConversationCache'
import {
  installScrollTestEnvironment,
  allResizeCallbacks,
  flushObservedLayout,
  fromBottom,
  messageText,
  mockRect,
  mockScrollRelativeRect,
  flushScheduledTimers,
  flushStreamingFollow,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: restore', () => {
  installScrollTestEnvironment()

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

    fireEvent.wheel(scroller, { deltaY: -120 })
    fireEvent.scroll(scroller)
    rerender(<ScrollableMessageArea conversationKey="conversation-b" messages={[messageB]} />)
    expect(screen.getByTestId('chat-message-scroll-area')).toBe(scroller)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    rerender(<ScrollableMessageArea conversationKey="conversation-a" messages={[messageA]} />)
    expect(screen.getByTestId('chat-message-scroll-area')).toBe(scroller)

    act(() => {
      flushObservedLayout()
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
    flushStreamingFollow()

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
    const messageElementA = messageText('cached conversation a').closest('[data-message-id]')

    rerender(<ScrollableMessageArea conversationKey="cached-b" messages={[messageB]} />)

    expect(messageElementA?.isConnected).toBe(false)
    expect(messageText('cached conversation b')).toBeInTheDocument()

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

    expect(messageText('cached render conversation a')).toBeInTheDocument()
    messageAContentReads = 0

    rerender(<ScrollableMessageArea conversationKey="cached-render-b" messages={[messageB]} />)

    expect(messageText('cached render conversation b')).toBeInTheDocument()
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
    mockRect(messageText('会话 A 前置内容').closest('[data-message-id]')!, -160, -20)
    mockRect(messageText('会话 A 当前阅读内容').closest('[data-message-id]')!, 80, 220)
    mockRect(messageText('会话 A 后续内容').closest('[data-message-id]')!, 240, 360)

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
      messageText('会话 A 当前阅读内容').closest('[data-message-id]')!,
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
    mockRect(messageText('默认配置').closest('[data-scroll-anchor]')!, -220, -188)
    mockRect(messageText('构建运行').closest('[data-scroll-anchor]')!, -170, -138)
    mockRect(messageText('主要功能').closest('[data-scroll-anchor]')!, -78, -42)
    mockRect(messageText('Node').closest('[data-scroll-anchor]')!, 92, 124)
    mockRect(messageText('Pod').closest('[data-scroll-anchor]')!, 140, 172)

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
    mockScrollRelativeRect(messageText('Node').closest('[data-scroll-anchor]')!, scroller, 520, 32)

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
          allResizeCallbacks.add(callback)
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
      flushObservedLayout()
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
      flushObservedLayout()
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
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: fromBottom(scroller, 0),
      behavior: 'auto',
    })
  })
})
