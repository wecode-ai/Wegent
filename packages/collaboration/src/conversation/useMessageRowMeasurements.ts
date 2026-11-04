import { useCallback, useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import type { ConversationVirtualizer } from './useConversationVirtualizer'
import type { VirtualMessageMeasurement } from './MessageList'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'

const initialBounds = new WeakMap<HTMLElement, DOMRect>()

/** TanStack owns the observer, resize batching, and the only size writer. */
export function useMessageRowMeasure(
  onMeasurement?: (measurement: VirtualMessageMeasurement) => void
) {
  return useCallback(
    (
      row: HTMLElement,
      entry: ResizeObserverEntry | undefined,
      virtualizer: ConversationVirtualizer
    ) => {
      const index = Number(row.dataset.index)
      const item = virtualizer.getVirtualItems().find(item => item.index === index)
      const border = entry?.borderBoxSize?.[0]
      const rect = border ? null : (initialBounds.get(row) ?? row.getBoundingClientRect())
      const width = border?.inlineSize ?? rect!.width
      const height = border?.blockSize ?? rect!.height
      const measuredSize = Math.round(height)
      if (width <= 0 || height <= 0) return item?.size ?? virtualizer.options.estimateSize(index)
      if (item?.size !== measuredSize && (onMeasurement || isConversationDiagnosticsEnabled())) {
        const previousTotalSize = virtualizer.getTotalSize()
        const details = {
          ...getConversationDiagnosticContext(row),
          rowIndex: index,
          previousSize: item?.size ?? null,
          measuredSize,
          sizeDelta: measuredSize - (item?.size ?? 0),
          estimatedSize: virtualizer.options.estimateSize(index),
          totalSize: previousTotalSize,
          rowStart: item?.start,
          rowEnd: item?.end,
          scrolling: virtualizer.isScrolling,
        }
        const messageId =
          row.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId ?? null
        queueMicrotask(() => {
          if (isConversationDiagnosticsEnabled())
            recordConversationDiagnostic('virtual-measurement', details)
          onMeasurement?.({
            messageId,
            previousSize: item?.size ?? null,
            measuredSize,
            previousTotalSize,
            nextTotalSize: virtualizer.getTotalSize(),
          })
        })
      }
      return measuredSize
    },
    [onMeasurement]
  )
}

export function useMessageRowMeasurements(
  listRef: RefObject<HTMLDivElement | null>,
  virtualizer: ConversationVirtualizer,
  enabled: boolean
) {
  const measureRows = useCallback(
    (rows: HTMLElement[]) => {
      if (!enabled) return
      const attached = rows.filter(row => listRef.current?.contains(row))
      // Read the complete initial batch before registering rows can update virtual layout.
      attached.forEach(row => initialBounds.set(row, row.getBoundingClientRect()))
      attached.forEach(row => {
        // Native scroll observation can still be active during task restoration.
        // Commit the same DOM measurement before paint; measureElement otherwise
        // defers it until ResizeObserver and exposes the estimated row for a frame.
        const index = Number(row.dataset.index)
        const size = virtualizer.options.measureElement(row, undefined, virtualizer)
        const item = virtualizer.getVirtualItems().find(item => item.index === index)
        if (item && item.size !== size) virtualizer.resizeItem(index, size)
        virtualizer.measureElement(row)
        initialBounds.delete(row)
      })
    },
    [enabled, listRef, virtualizer]
  )

  useLayoutEffect(() => {
    if (!enabled) return
    virtualizer.measureElement(null)
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-message-row][data-index]') ?? []
    )
    const changed = rows.filter(
      row =>
        virtualizer.elementsCache.get(virtualizer.options.getItemKey(Number(row.dataset.index))) !==
        row
    )
    if (changed.length) measureRows(changed)
  })
  const measureRow = useCallback((row: HTMLElement) => measureRows([row]), [measureRows])
  return { measureRow, measureRows }
}
