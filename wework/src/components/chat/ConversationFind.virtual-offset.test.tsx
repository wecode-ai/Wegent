import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { scrollToContentPosition } from '../../../../packages/collaboration/src/conversation/conversationViewportScroll'
import { useConversationVirtualizer } from '../../../../packages/collaboration/src/conversation/useConversationVirtualizer'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('search writes update the virtual offset before a native scroll event or resize', () => {
  const scroller = document.createElement('div')
  const list = document.createElement('div')
  scroller.append(list)
  Object.defineProperties(scroller, {
    clientHeight: { value: 300 },
    offsetHeight: { value: 300 },
    offsetWidth: { value: 800 },
    scrollHeight: { value: 2000 },
  })
  scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    scroller.scrollTop = Number(top)
  })
  const scrollElementRef = { current: scroller }
  const listRef = { current: list }
  const { result, unmount } = renderHook(() =>
    useConversationVirtualizer({
      enabled: true,
      count: 20,
      estimateSize: () => 100,
      scrollElementRef,
      listRef,
      initialDistanceFromBottomPx: 0,
      anchorTo: 'start',
    })
  )
  expect(result.current.virtualizer.scrollOffset).toBe(1700)

  act(() => scrollToContentPosition(scroller, 100, 'auto'))

  expect(result.current.virtualizer.scrollOffset).toBe(100)
  // Search navigation disables resize compensation until it releases ownership.
  result.current.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  act(() => result.current.virtualizer.resizeItem(0, 200))
  expect(scroller.scrollTop).toBe(100)
  unmount()
  expect(() => scrollToContentPosition(scroller, 50, 'auto')).not.toThrow()
})

test('engine instant writes publish their actual offset before native scroll delivery', () => {
  const scroller = document.createElement('div')
  const list = document.createElement('div')
  scroller.append(list)
  Object.defineProperties(scroller, {
    clientHeight: { value: 300 },
    offsetHeight: { value: 300 },
    offsetWidth: { value: 800 },
    scrollHeight: { value: 2000 },
  })
  scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    scroller.scrollTop = Number(top)
  })
  const { result, unmount } = renderHook(() =>
    useConversationVirtualizer({
      enabled: true,
      count: 20,
      estimateSize: () => 100,
      scrollElementRef: { current: scroller },
      listRef: { current: list },
      initialDistanceFromBottomPx: 0,
      anchorTo: 'start',
    })
  )

  act(() => result.current.virtualizer.scrollToOffset(100, { behavior: 'auto' }))

  expect(scroller.scrollTop).toBe(100)
  expect(result.current.virtualizer.scrollOffset).toBe(100)
  unmount()
})
