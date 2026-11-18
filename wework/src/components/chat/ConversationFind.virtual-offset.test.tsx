import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { scrollToContentPosition } from '../../../../packages/collaboration/src/conversation/conversationViewportScroll'
import { useConversationVirtualizer } from '../../../../packages/collaboration/src/conversation/useConversationVirtualizer'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

test('a new hidden viewport resets readiness and ignores the detached viewport observer', () => {
  const observers: Array<{ targets: Set<Element>; emit: () => void }> = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      targets = new Set<Element>()
      emit: () => void
      constructor(callback: ResizeObserverCallback) {
        this.emit = () => callback([], this as unknown as ResizeObserver)
        observers.push(this)
      }
      observe(target: Element) {
        this.targets.add(target)
      }
      unobserve(target: Element) {
        this.targets.delete(target)
      }
      disconnect() {}
    }
  )
  function viewport(height: number) {
    const scroller = document.createElement('div')
    const list = document.createElement('div')
    scroller.append(list)
    Object.defineProperties(scroller, {
      clientHeight: { value: height },
      offsetHeight: { value: height },
      offsetWidth: { value: 800 },
      scrollHeight: { value: 2000 },
    })
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })
    return { scroller, list }
  }
  const visible = viewport(300)
  const hidden = viewport(0)
  const { result, rerender, unmount } = renderHook(
    ({ scroller, list }: { scroller: HTMLDivElement; list: HTMLDivElement | null }) =>
      useConversationVirtualizer({
        enabled: true,
        count: 20,
        estimateSize: () => 100,
        scrollElementRef: { current: scroller },
        listRef: { current: list },
        initialDistanceFromBottomPx: 0,
        anchorTo: 'start',
      }),
    { initialProps: visible }
  )
  expect(result.current.viewportReady).toBe(true)
  const oldObserver = observers.find(observer => observer.targets.has(visible.list))!
  rerender(hidden)
  expect(result.current.viewportReady).toBe(false)
  expect(result.current.virtualizer.options.enabled).toBe(false)
  visible.scroller.scrollTop = 37
  act(() => oldObserver.emit())
  expect(result.current.viewportReady).toBe(false)
  expect(result.current.virtualizer.options.enabled).toBe(false)
  rerender(visible)
  expect(result.current.viewportReady).toBe(true)
  rerender({ scroller: visible.scroller, list: null })
  expect(result.current.viewportReady).toBe(false)
  unmount()
})
