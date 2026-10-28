import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { getConversationScrollSnapshot } from '@/features/workbench/runtimeConversationCache'
import { getConversationDiagnosticsSnapshot } from '@wegent/collaboration/conversation/conversationDiagnostics'
import {
  installScrollTestEnvironment,
  allResizeCallbacks,
  flushObservedLayout,
  fromBottom,
  messageText,
  mockRect,
  mockScrollRelativeRect,
  createAnchorHarness,
  flushScheduledTimers,
  flushStreamingFollow,
} from './scrollableMessageTestHelpers'

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isDesktopRuntime: () => false,
}))

describe('ScrollableMessageArea: reading', () => {
  installScrollTestEnvironment()

  test('keeps the text in place when the whole list reflows around it', () => {
    const harness = createAnchorHarness()
    try {
      const { model } = harness
      const anchorBefore = model.anchorTopPx()
      model.sample()

      // Opening the file panel narrows the conversation: the text above the reader grows and so
      // does the text below it. This is the shape that broke the desktop e2e — the reader's
      // paragraph has to stay exactly where it was.
      model.apply({ aboveViewportGrowthPx: 600, belowViewportGrowthPx: 2_000 })
      harness.flushResizeObservers()

      expect(model.anchorTopPx()).toBe(anchorBefore)
    } finally {
      harness.dispose()
    }
  })

  test('keeps the reader own scrolling when a row above the viewport re-measures', () => {
    const harness = createAnchorHarness()
    try {
      const { model } = harness
      const anchorBefore = model.anchorTopPx()
      model.sample()

      // The reader scrolls 120px up while a row above them shrinks by 373px. Their scrolling has to
      // survive; the 373px the layout took away has to be given back.
      model.apply({ aboveViewportGrowthPx: -373, readerScrollPx: 120 })
      harness.flushResizeObservers()

      expect(model.anchorTopPx()).toBe(anchorBefore + 120)
    } finally {
      harness.dispose()
    }
  })

  test('does not let a re-measured row above the viewport drag the reader towards the bottom', () => {
    const harness = createAnchorHarness()
    try {
      const { scroller, model } = harness
      const anchorBefore = model.anchorTopPx()
      const scrollBefore = scroller.scrollTop
      model.sample()

      // A large estimate correction changes content coordinates above the reader.
      // Move the scroll offset by that delta to preserve the same visible text.
      model.apply({ aboveViewportGrowthPx: -2_393 })
      harness.flushResizeObservers()

      expect(model.anchorTopPx()).toBe(anchorBefore)
      expect(scroller.scrollTop).toBe(scrollBefore - 2_393)
    } finally {
      harness.dispose()
    }
  })

  test('keeps consecutive wheel steps stable through alternating row measurements', () => {
    const harness = createAnchorHarness()
    try {
      const { model } = harness
      const anchorBefore = model.anchorTopPx()
      model.sample()

      for (let step = 1; step <= 5; step += 1) {
        model.scrollAsUser(12)
        model.apply({
          aboveViewportGrowthPx: step % 2 === 0 ? 373 : -373,
          belowViewportGrowthPx: step % 2 === 0 ? -40 : 40,
          coalesceScrollEvent: true,
        })
        harness.flushResizeObservers()
        expect(model.anchorTopPx()).toBe(anchorBefore + step * 12)

        // Repeated layout notifications must not apply the correction a second time.
        harness.flushResizeObservers()
        expect(model.anchorTopPx()).toBe(anchorBefore + step * 12)
      }

      model.scrollAsUser(-60)
      expect(model.anchorTopPx()).toBe(anchorBefore)
    } finally {
      harness.dispose()
    }
  })

  test('keeps the text in place when the scroller box is re-laid out and the content grows with it', () => {
    const harness = createAnchorHarness()
    try {
      const { model } = harness
      const anchorBefore = model.anchorTopPx()
      model.sample()

      // Opening a panel beside the conversation narrows the scroller and every paragraph below the
      // reader re-wraps. The scroller keeps its pixel offset across that, so the text slides up the
      // screen unless the growth that landed under the reader is measured and given back.
      model.apply({ belowViewportGrowthPx: 240, scrollerWidthPx: 520 })
      harness.flushResizeObservers()

      expect(model.anchorTopPx()).toBe(anchorBefore)
    } finally {
      harness.dispose()
    }
  })

  test('preserves a wheel step before a row remeasurement notification arrives', () => {
    const harness = createAnchorHarness()
    try {
      const { model } = harness
      const anchorBefore = model.anchorTopPx()
      model.sample()

      // The wheel arrives before the resize notification. Only its requested movement may affect
      // the visible text; the height correction above it must not be counted as scrolling.
      model.apply({ aboveViewportGrowthPx: -332, coalesceScrollEvent: true })
      model.scrollAsUser(120)
      harness.flushResizeObservers()

      expect(model.anchorTopPx()).toBe(anchorBefore + 120)
    } finally {
      harness.dispose()
    }
  })

  test('does not take a re-layout as the reader own position when a click lands first', () => {
    const harness = createAnchorHarness()
    try {
      const { scroller, model } = harness
      const anchorBefore = model.anchorTopPx()
      model.sample()

      // Clicking a file link opens a panel beside the conversation. The pointer down marks input intent, and
      // the re-layout that follows moves the offset before its scroll event is read; taking that as the
      // position the reader chose is what left the paragraph they were reading above the pane's top edge.
      model.apply({ aboveViewportGrowthPx: -332, coalesceScrollEvent: true })
      fireEvent.pointerDown(scroller)
      fireEvent.scroll(scroller)
      harness.flushResizeObservers()

      expect(model.anchorTopPx()).toBe(anchorBefore)
    } finally {
      harness.dispose()
    }
  })

  test('keeps the reader own scrolling while the streaming response below it grows', () => {
    const harness = createAnchorHarness()
    try {
      const { model } = harness
      const anchorBefore = model.anchorTopPx()
      model.sample()

      // Scrolling through a response that keeps streaming: every frame changes the content height,
      // so the reader's own scrolling arrives in the same frame as the layout change. The growth
      // must not push the text away, and must not take the scrolling with it either.
      model.apply({ belowViewportGrowthPx: 400, readerScrollPx: 120 })
      harness.flushResizeObservers()

      expect(model.anchorTopPx()).toBe(anchorBefore + 120)
    } finally {
      harness.dispose()
    }
  })

  test('keeps the text in place while the streaming response below it grows', () => {
    const harness = createAnchorHarness()
    try {
      const { scroller, model } = harness
      const anchorBefore = model.anchorTopPx()
      const scrollBefore = scroller.scrollTop
      model.sample()

      // A streaming response grows 400px below the viewport with the reader parked. Only the last
      // row grew, so nothing underneath absorbs it: the whole history is pushed up by 400px unless
      // the offset is moved with it.
      model.apply({ belowViewportGrowthPx: 400 })
      harness.flushResizeObservers()

      expect(model.anchorTopPx()).toBe(anchorBefore)
      expect(scroller.scrollTop).toBe(scrollBefore)
      expect(getConversationDiagnosticsSnapshot()?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'anchor-correction',
            details: expect.objectContaining({ correction: 0, appliedCorrection: 0 }),
          }),
        ])
      )
    } finally {
      harness.dispose()
    }
  })

  test('does not guess a correction when the sampled text is no longer on screen', () => {
    const harness = createAnchorHarness()
    try {
      const { scroller, anchor, model } = harness
      const scrollBefore = scroller.scrollTop
      model.sample()

      anchor.closest('[data-message-id]')?.remove()
      model.apply({ aboveViewportGrowthPx: 600, belowViewportGrowthPx: 2_000 })
      harness.flushResizeObservers()

      // Without a surviving anchor, keep the native offset instead of inventing a correction.
      expect(scroller.scrollTop).toBe(scrollBefore)
      expect(getConversationDiagnosticsSnapshot()?.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'anchor-lost' })])
      )
    } finally {
      harness.dispose()
    }
  })

  test('keeps the reader own scrolling when a width reflow re-lays out a top-origin list', () => {
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

    try {
      render(
        <ScrollableMessageArea
          conversationKey="top-origin-width-reflow"
          messages={[
            {
              id: 'top-origin-width-reflow-message',
              role: 'assistant',
              content: '调整宽度后仍在阅读的段落',
              status: 'done',
              createdAt: '2026-08-30T00:00:00.000Z',
            },
          ]}
        />
      )

      const scroller = screen.getByTestId('chat-message-scroll-area')
      const anchor = messageText('调整宽度后仍在阅读的段落').closest('[data-scroll-anchor]')!
      let contentHeight = 2_000
      let anchorContentTop = 1_220
      Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get: () => contentHeight,
      })
      Object.defineProperty(scroller, 'scrollTop', {
        value: 1_000,
        writable: true,
        configurable: true,
      })
      scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
        scroller.scrollTop = Math.min(Number(top), contentHeight - scroller.clientHeight)
      })
      mockRect(scroller, 100, 300)
      anchor.getBoundingClientRect = vi.fn(() => {
        const top = anchorContentTop - scroller.scrollTop
        return {
          top,
          bottom: top + 40,
          left: 0,
          right: 320,
          width: 320,
          height: 40,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect
      })

      // The reader scrolls 120px up, then a width change reflows the list 300px shorter above them.
      scroller.scrollTop = 1_000
      fireEvent.wheel(scroller, { deltaY: -120 })
      fireEvent.scroll(scroller)
      scroller.scrollTop = 880
      fireEvent.scroll(scroller)
      contentHeight = 1_700
      anchorContentTop = 920
      act(() => {
        resizeCallbacks.forEach(callback =>
          callback([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
        )
      })

      // The reflow no longer moves the text the reader was reading, and their own 120px scroll is
      // still there: the paragraph sits 120px lower on screen than before they scrolled.
      expect(anchor.getBoundingClientRect().top).toBe(340)
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
    }
  })

  test('keeps the first visible text line fixed when width changes reflow a paragraph', () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    const originalResizeObserver = globalThis.ResizeObserver
    const originalCaretRangeDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'caretRangeFromPoint'
    )
    const originalGetClientRectsDescriptor = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getClientRects'
    )

    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
        allResizeCallbacks.add(callback)
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)

    try {
      render(
        <ScrollableMessageArea
          conversationKey="line-width-reflow"
          messages={[
            {
              id: 'line-width-reflow-message',
              role: 'assistant',
              content: '第一行需要在调整对话宽度后保持原来的屏幕位置。',
              status: 'done',
              createdAt: '2026-05-29T00:00:00.000Z',
            },
          ]}
        />
      )

      const scroller = screen.getByTestId('chat-message-scroll-area')
      const anchor = screen
        .getByText('第一行需要在调整对话宽度后保持原来的屏幕位置。')
        .closest('[data-scroll-anchor]')!
      const textNode = anchor.firstChild!
      const caretRange = document.createRange()
      caretRange.setStart(textNode, 4)
      caretRange.collapse(true)
      Object.defineProperty(document, 'caretRangeFromPoint', {
        configurable: true,
        value: vi.fn(() => caretRange),
      })

      let lineTopAtScrollZero = 410
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: vi.fn(() => {
          const top = lineTopAtScrollZero - scroller.scrollTop
          return [
            {
              top,
              bottom: top + 24,
              left: 0,
              right: 240,
              width: 240,
              height: 24,
              x: 0,
              y: top,
              toJSON: () => ({}),
            } as DOMRect,
          ]
        }),
      })

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
      mockScrollRelativeRect(anchor, scroller, 250, 400)

      scroller.scrollTop = 1000
      fireEvent.scroll(scroller)
      scroller.scrollTop = 300
      fireEvent.wheel(scroller)
      fireEvent.scroll(scroller)

      lineTopAtScrollZero = 650
      Object.defineProperty(scroller, 'scrollHeight', { value: 1440, configurable: true })
      act(() => {
        resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      })

      expect(scroller.scrollTop).toBe(540)
      expect(lineTopAtScrollZero - scroller.scrollTop).toBe(110)
    } finally {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
      if (originalCaretRangeDescriptor) {
        Object.defineProperty(document, 'caretRangeFromPoint', originalCaretRangeDescriptor)
      } else {
        Reflect.deleteProperty(document, 'caretRangeFromPoint')
      }
      if (originalGetClientRectsDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', originalGetClientRectsDescriptor)
      } else {
        Reflect.deleteProperty(Range.prototype, 'getClientRects')
      }
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
      value: fromBottom(scroller, 480),
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })

    fireEvent.wheel(scroller)
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
      top: fromBottom(scroller, 480),
      behavior: 'auto',
    })
  })

  test('saves the bottom target instead of a smooth-scroll intermediate position', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-smooth-bottom"
          externalScrollRef={externalScrollRef}
          messages={[
            {
              id: 'external-smooth-bottom-message',
              role: 'assistant',
              content: '桌面外部滚动容器中的长消息',
              status: 'done',
              createdAt: '2026-08-31T00:00:00.000Z',
            },
          ]}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      value: fromBottom(scroller, 200),
      writable: true,
      configurable: true,
    })
    scroller.scrollTo = vi.fn()

    fireEvent.wheel(scroller, { deltaY: -120 })
    fireEvent.scroll(scroller)
    const button = screen.getByTestId('scroll-to-bottom-button')

    fireEvent.pointerDown(button)
    fireEvent.click(button)
    act(() => {
      flushObservedLayout()
      vi.advanceTimersByTime(16)
    })

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: expect.any(Number),
      behavior: 'auto',
    })
    const requestedTop = vi.mocked(scroller.scrollTo).mock.lastCall![0].top!
    expect(requestedTop).toBeGreaterThan(fromBottom(scroller, 200))
    expect(requestedTop).toBeLessThan(fromBottom(scroller, 0))
    expect(scroller.scrollTop).toBe(fromBottom(scroller, 200))
    expect(getConversationScrollSnapshot('external-smooth-bottom')).toEqual({
      distanceFromBottomPx: 0,
      pinnedToBottom: true,
    })
  })

  test('keeps following the external scroller when a virtualized response grows after render', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const completedMessage = {
      id: 'completed-message',
      role: 'assistant' as const,
      content: '已完成的长会话',
      status: 'done' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-growing-stream"
          externalScrollRef={externalScrollRef}
          messages={[completedMessage]}
        />
      </div>
    )

    const scroller = externalScrollRef.current!
    let scrollHeight = 1000
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
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

    fireEvent.scroll(scroller)
    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    rerender(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-growing-stream"
          externalScrollRef={externalScrollRef}
          messages={[
            completedMessage,
            {
              id: 'late-measured-streaming-message',
              role: 'assistant',
              content: '刚开始流式输出',
              status: 'streaming',
              createdAt: '2026-05-29T00:00:01.000Z',
            },
          ]}
        />
      </div>
    )

    scrollHeight = 3000
    flushStreamingFollow()

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      top: fromBottom(scroller, 0),
      behavior: 'auto',
    })
    expect(scroller.scrollTop).toBe(fromBottom(scroller, 0))
  })

  test('stops external bottom following when the scroll position leaves the bottom', () => {
    const externalScrollRef = createRef<HTMLDivElement>()
    const streamingMessage = {
      id: 'external-streaming-message',
      role: 'assistant' as const,
      content: '正在流式输出',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-stream-a"
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
    rerender(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-stream-b"
          externalScrollRef={externalScrollRef}
          messages={[{ ...streamingMessage, id: 'external-streaming-message-b' }]}
        />
      </div>
    )
    rerender(
      <div ref={externalScrollRef}>
        <ScrollableMessageArea
          conversationKey="external-stream-a"
          externalScrollRef={externalScrollRef}
          messages={[streamingMessage]}
        />
      </div>
    )

    flushScheduledTimers()
    ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()

    scroller.scrollTop = fromBottom(scroller, 450)
    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    flushScheduledTimers()

    expect(scroller.scrollTo).not.toHaveBeenCalled()
    expect(getConversationScrollSnapshot('external-stream-a')).toEqual({
      distanceFromBottomPx: 450,
      pinnedToBottom: false,
    })
  })
})
