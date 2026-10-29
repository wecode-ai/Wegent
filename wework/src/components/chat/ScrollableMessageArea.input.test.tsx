import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { getConversationScrollSnapshot } from '@/features/workbench/runtimeConversationCache'
import { getConversationDiagnosticsSnapshot } from '@wegent/collaboration/conversation/conversationDiagnostics'
import {
  installScrollTestEnvironment,
  flushObservedLayout,
  fromBottom,
  flushScheduledTimers,
  flushStreamingFollow,
  parkConversationReader,
  parkedConversationMessages,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: input', () => {
  installScrollTestEnvironment()

  test('does not pull a reader parked in history down when the assistant turn starts waiting', () => {
    const { rerender } = render(
      <ScrollableMessageArea
        conversationKey="parked-waiting"
        messages={parkedConversationMessages}
      />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    parkConversationReader(scroller, 900)

    // The assistant's turn answering the reader's last message begins: the waiting indicator appears.
    rerender(
      <ScrollableMessageArea
        conversationKey="parked-waiting"
        messages={parkedConversationMessages}
        isWaitingForAssistant
      />
    )
    act(() => {
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    // A turn beginning to answer is not the reader's own action: their place in the history stands.
    expect(scroller.scrollTop).toBe(fromBottom(scroller, 900))
    expect(scroller.scrollTo).not.toHaveBeenCalled()
  })

  test('still brings the newest turn into view when the assistant starts waiting at the bottom', () => {
    const { rerender } = render(
      <ScrollableMessageArea
        conversationKey="bottom-waiting"
        messages={parkedConversationMessages}
      />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 2_000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn((options: ScrollToOptions) => {
      scroller.scrollTop = Number(options.top ?? 0) + 0
    }) as unknown as HTMLDivElement['scrollTo']
    fireEvent.scroll(scroller)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    rerender(
      <ScrollableMessageArea
        conversationKey="bottom-waiting"
        messages={parkedConversationMessages}
        isWaitingForAssistant
      />
    )
    act(() => {
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTop).toBe(fromBottom(scroller, 0))
    expect(getConversationScrollSnapshot('bottom-waiting')?.pinnedToBottom).toBe(true)
  })

  test('brings a message the reader sends into view even while they are parked in history', () => {
    const { rerender } = render(
      <ScrollableMessageArea conversationKey="parked-send" messages={parkedConversationMessages} />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    parkConversationReader(scroller, 900)

    rerender(
      <ScrollableMessageArea
        conversationKey="parked-send"
        messages={[
          ...parkedConversationMessages,
          {
            id: 'parked-user-3',
            role: 'user',
            content: '第三问',
            status: 'done',
            createdAt: '2026-09-18T00:00:03.000Z',
          },
        ]}
        isWaitingForAssistant
      />
    )
    act(() => {
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTop).toBe(fromBottom(scroller, 0))
    expect(scroller.scrollTo).toHaveBeenCalled()
  })

  test('does not pull a parked reader down when a held response start is released', () => {
    const { rerender } = render(
      <ScrollableMessageArea
        conversationKey="held-start"
        messages={parkedConversationMessages}
        autoScrollSuspended
      />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 2_000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn((options: ScrollToOptions) => {
      scroller.scrollTop = Number(options.top ?? 0) + 0
    }) as unknown as HTMLDivElement['scrollTo']

    // The response starts while auto-scroll is suspended, so bringing it into view is held back.
    rerender(
      <ScrollableMessageArea
        conversationKey="held-start"
        messages={[
          ...parkedConversationMessages,
          {
            id: 'held-start-assistant',
            role: 'assistant',
            content: '第二答',
            status: 'streaming',
            createdAt: '2026-09-18T00:00:03.000Z',
          },
        ]}
        autoScrollSuspended
      />
    )
    // The reader parks in the history before the suspension is lifted.
    fireEvent.wheel(scroller, { deltaY: -120 })
    scroller.scrollTop = fromBottom(scroller, 900)
    fireEvent.scroll(scroller)
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    rerender(
      <ScrollableMessageArea
        conversationKey="held-start"
        messages={[
          ...parkedConversationMessages,
          {
            id: 'held-start-assistant',
            role: 'assistant',
            content: '第二答',
            status: 'streaming',
            createdAt: '2026-09-18T00:00:03.000Z',
          },
        ]}
      />
    )
    act(() => {
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    })

    expect(scroller.scrollTop).toBe(fromBottom(scroller, 900))
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
      top: fromBottom(scroller, 0),
      behavior: 'auto',
    })
  })

  test('preserves an upward user scroll that stays within the bottom tolerance', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const streamingMessage = {
      id: 'within-bottom-tolerance-stream',
      role: 'assistant' as const,
      content: '正在流式输出',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="within-bottom-tolerance"
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
    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    // The user begins scrolling upward but the browser only moves a few pixels, so the
    // scroll event still reports the scroller within the bottom tolerance. The up-scroll
    // pause must survive so the follow engine does not yank the viewport back down.
    fireEvent.wheel(scroller, { deltaY: -80 })
    scroller.scrollTop = fromBottom(scroller, 4)
    fireEvent.scroll(scroller)

    rerender(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="within-bottom-tolerance"
          externalScrollRef={externalScrollRef}
          messages={[{ ...streamingMessage, content: '正在流式输出\n\n更多流式内容\n\n仍在增长' }]}
        />
      </div>
    )
    flushScheduledTimers()
    flushStreamingFollow()

    expect(scroller.scrollTo).not.toHaveBeenCalled()
  })

  test('samples scrollbar input once until the next scroll step is observed', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const externalScrollInteractionRef = createRef<HTMLDivElement>()
    render(
      <>
        <div ref={externalScrollRef}>
          <ScrollableMessageArea
            conversationKey="coalesced-scrollbar-input"
            externalScrollRef={externalScrollRef}
            externalScrollInteractionRef={externalScrollInteractionRef}
            messages={[
              {
                id: 'message',
                role: 'assistant',
                content: 'Reading',
                status: 'done',
                createdAt: '',
              },
            ]}
          />
        </div>
        <div ref={externalScrollInteractionRef} data-testid="coalesced-scrollbar" />
      </>
    )
    const scroller = externalScrollRef.current!
    Object.defineProperties(scroller, {
      clientHeight: { value: 200, configurable: true },
      scrollHeight: { value: 1000, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    })
    flushScheduledTimers()
    const track = screen.getByTestId('coalesced-scrollbar')
    const inputs = () =>
      getConversationDiagnosticsSnapshot()!.events.filter(event => event.name === 'scroll-input')

    for (let step = 0; step < 10; step++) fireEvent.pointerMove(track, { buttons: 1 })
    expect(inputs()).toHaveLength(1)
    scroller.scrollTop = fromBottom(scroller, 120)
    fireEvent.scroll(scroller)
    for (let step = 0; step < 10; step++) fireEvent.pointerMove(track, { buttons: 1 })
    expect(inputs()).toHaveLength(2)
    scroller.scrollTop = fromBottom(scroller, 240)
    fireEvent.scroll(scroller)
    expect(getConversationScrollSnapshot('coalesced-scrollbar-input')?.distanceFromBottomPx).toBe(
      240
    )
  })

  test('treats dragging an external scrollbar as user scroll intent', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const externalScrollInteractionRef = createRef<HTMLDivElement>()
    const streamingMessage = {
      id: 'external-scrollbar-drag-stream',
      role: 'assistant' as const,
      content: '正在流式输出',
      status: 'streaming' as const,
      createdAt: '2026-09-18T00:00:00.000Z',
    }
    const { rerender } = render(
      <>
        <div ref={externalScrollRef}>
          <ScrollableMessageArea
            conversationKey="external-scrollbar-drag"
            externalScrollRef={externalScrollRef}
            externalScrollInteractionRef={externalScrollInteractionRef}
            messages={[streamingMessage]}
          />
        </div>
        <div ref={externalScrollInteractionRef} data-testid="external-scrollbar" />
      </>
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
    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    fireEvent.pointerDown(screen.getByTestId('external-scrollbar'))
    scroller.scrollTop = fromBottom(scroller, 120)
    fireEvent.scroll(scroller)

    fireEvent.pointerMove(screen.getByTestId('external-scrollbar'), { buttons: 1 })
    scroller.scrollTop = fromBottom(scroller, 240)
    fireEvent.scroll(scroller)

    rerender(
      <>
        <div ref={externalScrollRef}>
          <ScrollableMessageArea
            conversationKey="external-scrollbar-drag"
            externalScrollRef={externalScrollRef}
            externalScrollInteractionRef={externalScrollInteractionRef}
            messages={[
              {
                ...streamingMessage,
                content: '正在流式输出\n\n更多流式内容\n\n仍在增长',
              },
            ]}
          />
        </div>
        <div ref={externalScrollInteractionRef} data-testid="external-scrollbar" />
      </>
    )
    flushScheduledTimers()
    flushStreamingFollow()

    expect(scroller.scrollTo).not.toHaveBeenCalled()
  })

  test('keeps the conversation pinned to the bottom while it keeps growing after jump-to-bottom', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const streamingMessage = {
      id: 'jump-to-bottom-growing-stream',
      role: 'assistant' as const,
      content: '正在流式输出',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="jump-to-bottom-growing"
          externalScrollRef={externalScrollRef}
          messages={[streamingMessage]}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: fromBottom(scroller, 300),
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.wheel(scroller, { deltaY: -120 })
    fireEvent.scroll(scroller)
    flushScheduledTimers()

    fireEvent.click(screen.getByTestId('scroll-to-bottom-button'))
    flushScheduledTimers()
    flushStreamingFollow()

    // The conversation keeps growing well past the original release window. The bottom
    // follow must stay pinned so the viewport does not end up in the middle.
    for (let index = 0; index < 8; index += 1) {
      rerender(
        <div ref={externalScrollRef}>
          <ScrollableMessageArea
            conversationKey="jump-to-bottom-growing"
            externalScrollRef={externalScrollRef}
            messages={[
              {
                ...streamingMessage,
                content: `正在流式输出\n\n增长批次 ${index + 1}\n\n${Array.from(
                  { length: 40 },
                  (_, p) => `段落 ${index + 1}-${p + 1}`
                ).join('\n')}`,
              },
            ]}
          />
        </div>
      )
      flushScheduledTimers()
      flushStreamingFollow()
    }

    expect(getConversationScrollSnapshot('jump-to-bottom-growing')?.pinnedToBottom).toBe(true)
    expect(scroller.scrollTop).toBeCloseTo(fromBottom(scroller, 0))
  })
})
