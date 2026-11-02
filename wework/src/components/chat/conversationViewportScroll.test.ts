import { describe, expect, test, vi } from 'vitest'
import {
  getContentPositionForViewportY,
  getDistanceFromBottom,
  getDistanceFromTop,
  getScrollViewportBounds,
  setDistanceFromBottom,
  scrollToContentPosition,
} from '../../../../packages/collaboration/src/conversation/conversationViewportScroll'

function createScroller(scrollTop: number) {
  const element = document.createElement('div')
  Object.defineProperties(element, {
    clientHeight: { value: 200, configurable: true },
    scrollHeight: { value: 1_000, configurable: true },
    scrollTop: { value: scrollTop, writable: true, configurable: true },
  })
  element.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    element.scrollTop = Number(top)
  })
  return element
}

describe('conversation viewport coordinates', () => {
  test('uses positive DOM offsets and distances from either edge', () => {
    const element = createScroller(480)

    expect(getDistanceFromBottom(element)).toBe(320)
    expect(getDistanceFromTop(element)).toBe(480)
    expect(getScrollViewportBounds(element)).toEqual({ startPx: 480, endPx: 680 })

    setDistanceFromBottom(element, 0, 'auto')
    expect(element.scrollTop).toBe(800)

    setDistanceFromBottom(element, 180, 'auto')
    expect(element.scrollTop).toBe(620)
  })

  test('writes content offsets without an origin adapter', () => {
    const element = createScroller(0)

    scrollToContentPosition(element, 250, 'auto')

    expect(element.scrollTop).toBe(250)
    expect(getScrollViewportBounds(element).startPx).toBe(250)
  })

  test('resolves a screen coordinate inside the content', () => {
    const element = createScroller(480)
    element.getBoundingClientRect = () => ({ top: 100 }) as DOMRect

    expect(getContentPositionForViewportY(element, 160)).toBe(540)
  })
})
