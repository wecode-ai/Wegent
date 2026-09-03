import { describe, expect, test, vi } from 'vitest'
import {
  getContentPositionForViewportY,
  getDistanceFromBottom,
  getDistanceFromTop,
  getScrollViewportBounds,
  setDistanceFromBottom,
  scrollToContentPosition,
} from './bottomOriginScroll'

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

describe('bottom-origin scroll coordinates', () => {
  test('uses zero as the physical bottom and negative offsets above it', () => {
    const element = createScroller(-320)
    element.dataset.scrollOrigin = 'bottom'

    expect(getDistanceFromBottom(element, true)).toBe(320)
    expect(getDistanceFromTop(element, true)).toBe(480)
    expect(getScrollViewportBounds(element)).toEqual({ startPx: 480, endPx: 680 })

    setDistanceFromBottom(element, 0, 'auto', true)
    expect(element.scrollTop).toBe(-0)

    setDistanceFromBottom(element, 180, 'auto', true)
    expect(element.scrollTop).toBe(-180)
  })

  test('maps virtualizer top offsets back to the bottom-origin DOM coordinate', () => {
    const element = createScroller(0)
    element.dataset.scrollOrigin = 'bottom'

    scrollToContentPosition(element, 250, 'auto')

    expect(element.scrollTop).toBe(-550)
    expect(getScrollViewportBounds(element).startPx).toBe(250)
  })

  test('resolves viewport geometry without exposing top-origin coordinates', () => {
    const element = createScroller(-320)
    element.dataset.scrollOrigin = 'bottom'
    element.getBoundingClientRect = () => ({ top: 100 }) as DOMRect

    expect(getContentPositionForViewportY(element, 160)).toBe(540)
  })
})
