import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import {
  cacheConversationScrollSnapshot,
  getConversationScrollSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import {
  installScrollTestEnvironment,
  allResizeCallbacks,
  flushObservedLayout,
  messageText,
  mockRect,
  mockScrollRelativeRect,
  flushScheduledTimers,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: navigation-targets', () => {
  installScrollTestEnvironment()

  test('keeps turn navigation in control while a clicked target settles', () => {
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
    const firstMessageAnchor = messageText('第一条需求').closest('[data-message-id]')!
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
    act(() => {
      for (const callback of [...allResizeCallbacks]) callback([], {} as ResizeObserver)
    })
    expect(scroller.scrollTop).toBe(84)
    act(() => {
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })
    expect(scroller.scrollTop).toBe(84)
    fireEvent(scroller, new Event('scrollend'))
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
    const firstMessageAnchor = messageText('旧会话第一条需求').closest('[data-message-id]')!
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
    act(() => {
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

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
      turnId: 'turn-latest',
      role: 'user' as const,
      content: '最新需求',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:02.000Z',
      runtimeMessageIndex: 2,
    }
    const turnNavigation = [
      {
        id: 'runtime-older-user',
        turnId: 'turn-older',
        turnIndex: 0,
        messageIndex: 0,
        cursor: 'offset:0',
        promptPreview: '历史需求',
        responsePreview: '历史回复',
      },
      {
        id: 'runtime-latest-user',
        turnId: 'turn-latest',
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
    mockRect(messageText('最新需求').closest('[data-message-id]')!, 620, 680)

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
    const firstMessage = messageText('触发模型报错').closest('[data-message-id]')!
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
    // The scroll container always owns its own anchor position now, so the browser never adjusts
    // the offset behind the reader's back; the scroll area puts the text back itself.
    expect(scroller).toHaveClass('[overflow-anchor:none]')
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
})
