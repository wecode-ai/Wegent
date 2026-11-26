// @vitest-environment jsdom
import { act, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { useConversationVirtualizer } from './useConversationVirtualizer'
import { useMessageRowMeasure, useMessageRowMeasurements } from './useMessageRowMeasurements'

const rowSelector = '[data-message-row]'
const rowHeight = 10
const viewportHeight = 2000

function Conversation({
  cachedSize,
  onFirstLayout,
  onBatchLayout,
}: {
  cachedSize?: number
  onFirstLayout: (size?: number) => void
  onBatchLayout: (
    rowCount: number,
    measured: boolean,
    sizeAfterStaleEntry: number,
    sameWidthObservedSize: number,
    certifiedSize: number
  ) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const scrollElementRef = useRef<HTMLDivElement>(null)
  const certifiedSize = useRef(0)
  const measureElement = useMessageRowMeasure(
    undefined,
    (_row, _width, size) => {
      certifiedSize.current = size
    },
    640
  )
  const { virtualizer } = useConversationVirtualizer({
    count: 300,
    estimateSize: () => 4000,
    initialMeasurementsCache: cachedSize
      ? [
          {
            index: 0,
            key: 0,
            start: 0,
            end: cachedSize,
            size: cachedSize,
            lane: 0,
          },
        ]
      : [],
    enabled: true,
    overscan: 2,
    listRef,
    measureElement,
    scrollElementRef,
    initialDistanceFromBottomPx: 2_000_000,
  })
  const rows = virtualizer.getVirtualItems()
  const { measureRows } = useMessageRowMeasurements(listRef, virtualizer, true)
  const requestedBatch = useRef(false)
  useLayoutEffect(() => {
    const first = rows[0]
    if (first) onFirstLayout(virtualizer.itemSizeCache.get(first.key))
  }, [onFirstLayout, virtualizer, rows])
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !rows.length || requestedBatch.current) return
    requestedBatch.current = true
    const attached = () => Array.from(list.querySelectorAll<HTMLElement>(rowSelector))
    measureRows(attached(), () => {
      const measuredRows = attached()
      // A queued native observation from a different width may arrive after
      // the resize batch. It must resolve to the current DOM height.
      const sizeAfterStaleEntry = virtualizer.options.measureElement(
        measuredRows[0],
        { borderBoxSize: [{ inlineSize: 320, blockSize: 4000 }] } as ResizeObserverEntry,
        virtualizer
      )
      // A delayed entry can have the current width but the height of a
      // placeholder that has already been replaced by rendered content.
      const sameWidthObservedSize = virtualizer.options.measureElement(
        measuredRows[0],
        { borderBoxSize: [{ inlineSize: 640, blockSize: 4000 }] } as ResizeObserverEntry,
        virtualizer
      )
      onBatchLayout(
        measuredRows.length,
        measuredRows.every(
          row => virtualizer.itemSizeCache.get(Number(row.dataset.index)) === rowHeight
        ),
        sizeAfterStaleEntry,
        sameWidthObservedSize,
        certifiedSize.current
      )
    })
  }, [measureRows, onBatchLayout, rows, virtualizer])
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

test.each([
  { cachedSize: undefined, firstSize: rowHeight },
  { cachedSize: 4000, firstSize: 4000 },
])(
  'restores row geometry before converging ($cachedSize cached)',
  async ({ cachedSize, firstSize }) => {
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
      const onBatchLayout = vi.fn()
      await act(async () =>
        root.render(
          <Conversation
            cachedSize={cachedSize}
            onFirstLayout={onFirstLayout}
            onBatchLayout={onBatchLayout}
          />
        )
      )
      expect(onFirstLayout.mock.calls[0]).toEqual([firstSize])
      expect(container.querySelectorAll(rowSelector)).toHaveLength(viewportHeight / rowHeight + 2)
      expect(onBatchLayout).toHaveBeenCalledExactlyOnceWith(
        viewportHeight / rowHeight + 2,
        true,
        rowHeight,
        4000,
        rowHeight
      )
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  }
)
