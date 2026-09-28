import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScrollableMessageArea } from './ScrollableMessageArea'
import { MessageList } from './MessageList'
import { getDistanceFromTop } from './bottomOriginScroll'
import type { WorkbenchMessage } from '@/types/workbench'

const messages: WorkbenchMessage[] = [
  {
    id: 'long-user-message',
    role: 'user',
    content: Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join('\n'),
    status: 'done',
    createdAt: '2026-09-16T00:00:00.000Z',
  },
]

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test.each([
  { scrollOrigin: 'top' as const, initialDistance: 0 },
  { scrollOrigin: 'bottom' as const, initialDistance: 0 },
  { scrollOrigin: 'top' as const, initialDistance: 180 },
  { scrollOrigin: 'bottom' as const, initialDistance: 180 },
])(
  'expands downward from $scrollOrigin origin, $initialDistance px above bottom',
  ({ scrollOrigin, initialDistance }) => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
    render(
      <ScrollableMessageArea
        conversationKey={`expansion-${scrollOrigin}-${initialDistance}`}
        scrollOrigin={scrollOrigin}
        messages={messages}
      />
    )
    const scroller = screen.getByTestId('chat-message-scroll-area')
    let scrollHeight = 1000
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { get: () => scrollHeight, configurable: true })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })
    act(() => vi.runAllTimers())
    scroller.scrollTop = scrollOrigin === 'bottom' ? -initialDistance : 700 - initialDistance
    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)
    const before = getDistanceFromTop(scroller, scrollOrigin === 'bottom')
    const toggle = screen.getByTestId('toggle-user-message-button')

    fireEvent.pointerDown(toggle)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    scrollHeight = 1600
    // A native scroll event can arrive before the content resize notification.
    fireEvent.scroll(scroller)
    act(() => resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver)))
    expect(getDistanceFromTop(scroller, scrollOrigin === 'bottom')).toBe(before)

    // Subsequent layout notifications must not restart bottom following.
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver))
      vi.runOnlyPendingTimers()
    })
    expect(getDistanceFromTop(scroller, scrollOrigin === 'bottom')).toBe(before)

    fireEvent.click(toggle)
    scrollHeight = 1000
    act(() => resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver)))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(getDistanceFromTop(scroller, scrollOrigin === 'bottom')).toBe(before)
  }
)

test('uses the latest toggle callback when messages stay unchanged', () => {
  const previousCallback = vi.fn()
  const nextCallback = vi.fn()
  const { rerender } = render(
    <MessageList messages={messages} onBeforeUserMessageToggle={previousCallback} />
  )
  rerender(<MessageList messages={messages} onBeforeUserMessageToggle={nextCallback} />)

  fireEvent.click(screen.getByTestId('toggle-user-message-button'))

  expect(previousCallback).not.toHaveBeenCalled()
  expect(nextCallback).toHaveBeenCalledOnce()
})
