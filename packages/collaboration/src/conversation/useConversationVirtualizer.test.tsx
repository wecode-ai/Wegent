// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  useConversationVirtualizer,
  type ConversationVirtualizer,
} from './useConversationVirtualizer'

it('preserves the visible anchor when a row resizes before an external scroll event arrives', async () => {
  const observers = new Map<Element, ResizeObserverCallback>()
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
    },
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
  list.getBoundingClientRect = () =>
    new DOMRect(0, -viewport.scrollTop, 400, 6000)
  row.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 400, 80)
  viewport.scrollTo = (options) => {
    if (typeof options === 'object' && options.top !== undefined)
      viewport.scrollTop = options.top
  }
  let current!: ConversationVirtualizer
  function Harness() {
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
        [{ target: row, borderBoxSize: [{ inlineSize: 400, blockSize: 100 }] }] as ResizeObserverEntry[],
        {} as ResizeObserver,
      )
      expect(viewport.scrollTop).toBe(1250)
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
    })
    expect(viewport.scrollTop).toBe(1270)
  } finally {
    await act(async () => root.unmount())
    viewport.remove()
    mount.remove()
    vi.unstubAllGlobals()
  }
})
