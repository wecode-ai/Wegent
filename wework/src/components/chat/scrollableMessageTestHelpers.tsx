import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import {
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from '@wegent/collaboration/conversation/conversationDiagnostics'

export const allResizeCallbacks = new Set<ResizeObserverCallback>()
const observedLayoutStamps = new Map<ResizeObserverCallback, string>()
export function flushObservedLayout() {
  const stamp = JSON.stringify(
    [...document.querySelectorAll<HTMLElement>('[data-scroll-origin]')].map(element => [
      element.clientWidth,
      element.clientHeight,
      element.scrollHeight,
    ])
  )
  for (const callback of [...allResizeCallbacks]) {
    if (observedLayoutStamps.get(callback) === stamp) continue
    observedLayoutStamps.set(callback, stamp)
    callback([], {} as ResizeObserver)
  }
}
export function fromBottom(scroller: HTMLElement, distance: number) {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight - distance)
}

export function messageText(text: Parameters<typeof screen.getByText>[0]) {
  const content = screen.queryByTestId('chat-message-scroll-area-content')
  return content ? within(content).getByText(text) : screen.getByText(text)
}

export function mockRect(element: Element, top: number, bottom: number) {
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

export function mockScrollRelativeRect(
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

interface ReaderLayoutModel {
  /** Records the current position as the sample a layout change is measured against. */
  sample: () => void
  /**
   * Models Chromium's normal scroller with overflow-anchor:none: layout changes preserve
   * scrollTop unless the new range clamps it. Content coordinates change independently.
   *
   * - `aboveViewportGrowthPx` moves the anchor down the content (positive) or up it (negative), which
   *   is what a re-measured row above the viewport or a whole-list reflow does;
   * - `belowViewportGrowthPx` only makes the content taller underneath the anchor;
   * - `readerScrollPx` is the reader's own scrolling;
   * - `scrollerWidthPx` re-lays out the scroller's own box, as opening a panel beside the conversation
   *   does;
   * - `coalesceScrollEvent` delays the scroll handler until the next input or layout notification.
   */
  apply: (change: {
    aboveViewportGrowthPx?: number
    belowViewportGrowthPx?: number
    readerScrollPx?: number
    scrollerWidthPx?: number
    coalesceScrollEvent?: boolean
  }) => void
  /** The reader's own wheel step: the handler runs before the browser applies the scrolling. */
  scrollAsUser: (pixels: number) => void
  /** Where the sampled text sits on screen right now. */
  anchorTopPx: () => number
}

interface AnchorHarness {
  scroller: HTMLDivElement
  anchor: HTMLElement
  model: ReaderLayoutModel
  flushResizeObservers: () => void
  dispose: () => void
}

export function createAnchorHarness(): AnchorHarness {
  const resizeCallbacks: ResizeObserverCallback[] = []
  const originalResizeObserver = globalThis.ResizeObserver
  const CLIENT_HEIGHT = 200
  const SCROLLER_TOP = 100
  const HARNESS_MESSAGE_ID = 'anchor-harness-message'
  const HARNESS_TEXT = '锚点会话里正在阅读的长消息'
  const HARNESS_NEWER_TEXT = '锚点会话里更靠后的一条消息'
  // A later message sits this far down the content from the sampled one, so a height change can pull a
  // different paragraph to the top of the viewport.
  const NEWER_MESSAGE_OFFSET_PX = 282

  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
        allResizeCallbacks.add(callback)
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )

  const externalScrollRef = createRef<HTMLDivElement>()
  render(
    <div ref={externalScrollRef}>
      <ScrollableMessageArea
        conversationKey="anchor-harness"
        externalScrollRef={externalScrollRef}
        messages={[
          {
            id: HARNESS_MESSAGE_ID,
            role: 'assistant',
            content: HARNESS_TEXT,
            status: 'done',
            createdAt: '2026-09-11T00:00:00.000Z',
          },
          {
            id: 'anchor-harness-newer-message',
            role: 'assistant',
            content: HARNESS_NEWER_TEXT,
            status: 'done',
            createdAt: '2026-09-11T00:00:01.000Z',
          },
        ]}
      />
    </div>
  )

  const scroller = externalScrollRef.current!
  const anchor = messageText(HARNESS_TEXT).closest<HTMLElement>('[data-scroll-anchor]')!
  const newerAnchor = messageText(HARNESS_NEWER_TEXT).closest<HTMLElement>('[data-scroll-anchor]')!
  const layout = {
    clientWidthPx: 607,
    contentHeightPx: 10_000,
    distanceFromBottomPx: 4_000,
    anchorContentTopPx: 5_850,
  }
  Object.defineProperty(scroller, 'clientWidth', {
    configurable: true,
    get: () => layout.clientWidthPx,
  })
  Object.defineProperty(scroller, 'clientHeight', { value: CLIENT_HEIGHT, configurable: true })
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => layout.contentHeightPx,
  })
  Object.defineProperty(scroller, 'scrollTop', {
    value: layout.contentHeightPx - CLIENT_HEIGHT - layout.distanceFromBottomPx,
    writable: true,
    configurable: true,
  })
  scroller.scrollTo = vi.fn((options: ScrollToOptions) => {
    scroller.scrollTop = Number(options.top ?? 0)
  }) as unknown as HTMLDivElement['scrollTo']
  mockRect(scroller, SCROLLER_TOP, SCROLLER_TOP + CLIENT_HEIGHT)
  const mockAnchorRect = (element: Element, contentTopOffsetPx: number) => {
    element.getBoundingClientRect = vi.fn(() => {
      const top = SCROLLER_TOP + layout.anchorContentTopPx + contentTopOffsetPx - scroller.scrollTop
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
  }
  mockAnchorRect(anchor, 0)
  mockAnchorRect(newerAnchor, NEWER_MESSAGE_OFFSET_PX)

  return {
    scroller,
    anchor,
    model: {
      sample: () => {
        fireEvent.wheel(scroller, { deltaY: -120 })
        fireEvent.scroll(scroller)
      },
      apply: change => {
        const above = change.aboveViewportGrowthPx ?? 0
        const below = change.belowViewportGrowthPx ?? 0
        layout.contentHeightPx += above + below
        layout.anchorContentTopPx += above
        if (change.scrollerWidthPx !== undefined) {
          layout.clientWidthPx = change.scrollerWidthPx
        }
        const maximumOffsetPx = Math.max(0, layout.contentHeightPx - CLIENT_HEIGHT)
        scroller.scrollTop = Math.min(
          maximumOffsetPx,
          Math.max(0, scroller.scrollTop - (change.readerScrollPx ?? 0))
        )
        if (change.coalesceScrollEvent !== true) {
          fireEvent.scroll(scroller)
        }
      },
      scrollAsUser: pixels => {
        fireEvent.wheel(scroller, { deltaY: -pixels })
        scroller.scrollTop = Math.max(0, scroller.scrollTop - pixels)
        fireEvent.scroll(scroller)
      },
      anchorTopPx: () => anchor.getBoundingClientRect().top,
    },
    flushResizeObservers: () => {
      act(() => {
        resizeCallbacks.forEach(callback =>
          callback([] as ResizeObserverEntry[], {} as ResizeObserver)
        )
      })
    },
    dispose: () => {
      vi.stubGlobal('ResizeObserver', originalResizeObserver)
    },
  }
}

export function flushScheduledTimers() {
  act(() => {
    flushObservedLayout()
    vi.runOnlyPendingTimers()
  })
}

export function flushStreamingFollow() {
  act(() => {
    for (let frame = 0; frame < 180; frame += 1) {
      flushObservedLayout()
      vi.runOnlyPendingTimers()
    }
  })
}

// Parks a desktop conversation in history through an explicit reader gesture.
export function parkConversationReader(scroller: HTMLDivElement, parkedPx: number) {
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
  fireEvent.wheel(scroller, { deltaY: -120 })
  scroller.scrollTop = fromBottom(scroller, parkedPx)
  fireEvent.scroll(scroller)
  ;(scroller.scrollTo as ReturnType<typeof vi.fn>).mockClear()
}

export function installScrollTestEnvironment() {
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn>
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetConversationDiagnosticsForTest()
    startConversationDiagnosticCapture()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          allResizeCallbacks.add(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
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
    allResizeCallbacks.clear()
    observedLayoutStamps.clear()
    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
}

export const parkedConversationMessages = [
  {
    id: 'parked-user-1',
    role: 'user' as const,
    content: '第一问',
    status: 'done' as const,
    createdAt: '2026-09-18T00:00:00.000Z',
  },
  {
    id: 'parked-assistant-1',
    role: 'assistant' as const,
    content: '第一答',
    status: 'done' as const,
    createdAt: '2026-09-18T00:00:01.000Z',
  },
  {
    id: 'parked-user-2',
    role: 'user' as const,
    content: '第二问',
    status: 'done' as const,
    createdAt: '2026-09-18T00:00:02.000Z',
  },
]
