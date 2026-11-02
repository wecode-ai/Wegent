import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
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
  fromBottom,
  flushScheduledTimers,
  flushStreamingFollow,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: follow', () => {
  installScrollTestEnvironment()

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
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: fromBottom(scroller, 0),
      behavior: 'auto',
    })
  })

  test('starts from the latest message when restore is disabled for a preview', () => {
    cacheConversationScrollSnapshot('latest-preview', {
      distanceFromBottomPx: 420,
      pinnedToBottom: false,
    })
    render(
      <ScrollableMessageArea
        conversationKey="latest-preview"
        initialScrollPosition="latest"
        messages={[
          {
            id: 'latest-preview-message',
            role: 'assistant',
            content: '最新消息',
            status: 'done',
            createdAt: '2026-09-09T00:00:00.000Z',
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
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: fromBottom(scroller, 0),
      behavior: 'auto',
    })
    expect(getConversationScrollSnapshot('latest-preview')).toEqual({
      distanceFromBottomPx: 0,
      pinnedToBottom: true,
    })
  })

  test('keeps following the bottom while an unopened conversation is being measured', () => {
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
      flushObservedLayout()
      vi.advanceTimersByTime(0)
    })
    scrollHeight = 900
    fireEvent.scroll(scroller)
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
          allResizeCallbacks.add(callback)
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
    expect(scroller.scrollTop).toBe(fromBottom(scroller, 0))
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
      top: fromBottom(scroller, 0),
      behavior: 'auto',
    })
    expect(scroller.scrollTop).toBe(fromBottom(scroller, 0))
  })

  test('follows the assistant response after latest-user placement stabilizes', () => {
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
      top: fromBottom(scroller, 0),
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
          allResizeCallbacks.add(callback)
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
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument()
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: fromBottom(scroller, 0),
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
          allResizeCallbacks.add(callback)
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

    expect(scroller.scrollTop).toBe(fromBottom(scroller, 0))
    expect(getConversationScrollSnapshot('first-user-turn')?.pinnedToBottom).toBe(true)
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
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    flushStreamingFollow()
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: fromBottom(scroller, 0),
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

    expect(scroller.scrollTop).toBe(fromBottom(scroller, 0))
    expect(getConversationScrollSnapshot('suspended-assistant-start')?.pinnedToBottom).toBe(true)
  })
})
