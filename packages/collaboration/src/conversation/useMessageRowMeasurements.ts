import { useCallback, useLayoutEffect, useRef } from 'react'
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
  const pending = useRef(new Set<HTMLElement>())
  const measureRows = useCallback(
    (rows: HTMLElement[]) => {
      if (!enabled) return
      const attached = rows.filter(row => listRef.current?.contains(row))
      // Read the complete initial batch before registering rows can update virtual layout.
      attached.forEach(row => initialBounds.set(row, row.getBoundingClientRect()))
      attached.forEach(row => {
        if (virtualizer.isScrolling) pending.current.add(row)
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
    for (const row of pending.current) {
      if (!listRef.current?.contains(row)) pending.current.delete(row)
    }
    if (!virtualizer.isScrolling) {
      changed.push(...pending.current)
      pending.current.clear()
    }
    if (changed.length) measureRows([...new Set(changed)])
  })
  const measureRow = useCallback((row: HTMLElement) => measureRows([row]), [measureRows])
  return { measureRow, measureRows }
}
