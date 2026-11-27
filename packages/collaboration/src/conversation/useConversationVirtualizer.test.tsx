// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { scrollToContentPosition } from './conversationViewportScroll'
import {
  useConversationVirtualizer,
  type ConversationVirtualizer,
} from './useConversationVirtualizer'

it('keeps the visible anchor and scroll state in sync with native and programmatic scrolling', async () => {
  const observers = new Map<Element, ResizeObserverCallback>()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(element: Element) {
        observers.set(element, this.callback)
      }
      unobserve(element: Element) {
        observers.delete(element)
      }
      disconnect() {}
    }
  )
  const viewport = document.createElement('div')
  const list = document.createElement('div')
  const row = document.createElement('div')
  const mount = document.createElement('div')
  viewport.append(list)
  list.append(row)
  row.dataset.index = '0'
  Object.defineProperty(row, 'offsetHeight', { value: 80 })
  document.body.append(viewport, mount)
  for (const [key, value] of Object.entries({
    clientHeight: 300,
    offsetHeight: 300,
    clientWidth: 400,
    offsetWidth: 400,
    scrollHeight: 6000,
  }))
    Object.defineProperty(viewport, key, { configurable: true, value })
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  list.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 400, 6000)
  row.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 400, 80)
  viewport.scrollTo = options => {
    if (typeof options === 'object' && options.top !== undefined) viewport.scrollTop = options.top
  }
  let current!: ConversationVirtualizer
  function Harness({ restoreAnchor = false }: { restoreAnchor?: boolean }) {
    const { virtualizer } = useConversationVirtualizer({
      count: 100,
      estimateSize: () => 60,
      enabled: true,
      listRef: { current: list },
      scrollElementRef: { current: viewport },
      initialDistanceFromBottomPx: 5700,
    })
    useLayoutEffect(() => {
      current = virtualizer
    }, [virtualizer])
    useLayoutEffect(() => {
      if (!restoreAnchor) return
      // A layout restoration first writes the saved distance and then corrects
      // to the visible anchor. Only the final offset survives the commit.
      scrollToContentPosition(viewport, 100, 'auto')
      scrollToContentPosition(viewport, 1400, 'auto')
    })
    return null
  }
  const root = createRoot(mount)
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => {
      viewport.scrollTop = 1200
      const height = current.options.measureElement(row, undefined, current)
      expect(height).toBe(80)
      current.resizeItem(0, height)
    })
    expect(viewport.scrollTop).toBe(1220)

    await act(async () => current.measureElement(row))
    const onResize = observers.get(row)
    expect(onResize).toBeDefined()
    await act(async () => {
      viewport.scrollTop = 1250
      onResize!(
        [
          { target: row, borderBoxSize: [{ inlineSize: 400, blockSize: 100 }] },
        ] as ResizeObserverEntry[],
        {} as ResizeObserver
      )
      expect(viewport.scrollTop).toBe(1250)
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
    })
    expect(viewport.scrollTop).toBe(1270)

    await act(async () => {
      current.scrollToOffset(1400)
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(current.scrollOffset).toBe(1400)
    expect(current.isScrolling).toBe(false)

    await act(async () => root.render(<Harness restoreAnchor />))
    expect(current.scrollOffset).toBe(1400)
    expect(viewport.scrollTop).toBe(1400)
    await act(async () => root.render(<Harness />))

    await act(async () => {
      scrollToContentPosition(viewport, 100, 'auto')
      scrollToContentPosition(viewport, 1430, 'auto')
    })
    expect(current.scrollOffset).toBe(1430)
    expect(current.isScrolling).toBe(false)

    await act(async () => {
      viewport.scrollTop = 1450
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(current.scrollOffset).toBe(1450)
    expect(current.isScrolling).toBe(true)
  } finally {
    await act(async () => root.unmount())
    viewport.remove()
    mount.remove()
    vi.unstubAllGlobals()
  }
})
