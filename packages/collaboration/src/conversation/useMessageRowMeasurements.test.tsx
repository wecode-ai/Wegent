// @vitest-environment jsdom
import { act, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { useConversationVirtualizer } from './useConversationVirtualizer'
import { useMessageRowMeasure, useMessageRowMeasurements } from './useMessageRowMeasurements'

const rowSelector = '[data-message-row]'
const rowHeight = 10
const viewportHeight = 2000

function Conversation({ onFirstLayout }: { onFirstLayout: (size?: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const scrollElementRef = useRef<HTMLDivElement>(null)
  const measureElement = useMessageRowMeasure()
  const { virtualizer } = useConversationVirtualizer({
    count: 300,
    estimateSize: () => 4000,
    enabled: true,
    overscan: 2,
    listRef,
    measureElement,
    scrollElementRef,
    initialDistanceFromBottomPx: 2_000_000,
  })
  const rows = virtualizer.getVirtualItems()
  useMessageRowMeasurements(listRef, virtualizer, true)
  useLayoutEffect(() => {
    const first = rows[0]
    if (first) onFirstLayout(virtualizer.itemSizeCache.get(first.key))
  }, [onFirstLayout, virtualizer, rows])
  return (
    <div ref={scrollElementRef} data-viewport>
      <div ref={listRef}>
        {rows.map(row => (
          <div key={row.key} data-index={row.index} data-message-row />
        ))}
      </div>
    </div>
  )
}

test('converges when measured rows expose more rows than their estimates', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-viewport') ? viewportHeight : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.clientHeight
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return new DOMRect(0, 0, 640, this.matches(rowSelector) ? rowHeight : this.clientHeight)
  })
  try {
    const onFirstLayout = vi.fn()
    await act(async () => root.render(<Conversation onFirstLayout={onFirstLayout} />))
    expect(onFirstLayout.mock.calls[0]).toEqual([rowHeight])
    expect(container.querySelectorAll(rowSelector)).toHaveLength(viewportHeight / rowHeight + 2)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
