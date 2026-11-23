import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { flushSync } from 'react-dom'
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
  const pending = useRef<Set<HTMLElement> | null>(null)
  const initializedList = useRef<HTMLDivElement | null>(null)
  const measureRows = useCallback(
    (rows: HTMLElement[]) => {
      if (!enabled) return
      const queued = pending.current
      if (queued) {
        rows.forEach(row => queued.add(row))
        return
      }
      const batch = new Set(rows)
      pending.current = batch
      // New rows can enter the range after every measurement. Finish the React
      // commit before publishing sizes, while still correcting layout before paint.
      queueMicrotask(() => {
        if (pending.current !== batch) return
        pending.current = null
        const list = listRef.current
        if (!list?.isConnected || !virtualizer.options.enabled) return
        const attached = [...batch].filter(row => list.contains(row))
        if (attached.length) flushSync(() => measureAttachedRows(attached, list, virtualizer))
      })
    },
    [enabled, listRef, virtualizer]
  )

  useLayoutEffect(
    () => () => {
      pending.current = null
    },
    [enabled, virtualizer]
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
    if (changed.length === 0) return
    const list = listRef.current
    if (!list || initializedList.current === list) {
      measureRows(changed)
      return
    }
    initializedList.current = list
    // Restore with actual sizes in the first visible commit. Measuring subsequent
    // ranges outside the commit lets newly exposed rows converge without recursion.
    measureAttachedRows(changed, list, virtualizer)
  })
  const measureRow = useCallback((row: HTMLElement) => measureRows([row]), [measureRows])
  return { measureRow, measureRows }
}

function measureAttachedRows(
  rows: HTMLElement[],
  list: HTMLDivElement,
  virtualizer: ConversationVirtualizer
) {
  // Read layout once for the batch before updating any virtual positions.
  rows.forEach(row => initialBounds.set(row, row.getBoundingClientRect()))
  try {
    for (const row of rows) {
      if (!row.isConnected || !list.contains(row)) continue
      // TanStack skips synchronous measurement during native scrolling. Commit
      // the current DOM size before registering it for ongoing observation.
      const index = Number(row.dataset.index)
      const size = virtualizer.options.measureElement(row, undefined, virtualizer)
      const item = virtualizer.getVirtualItems().find(item => item.index === index)
      if (item && item.size !== size) virtualizer.resizeItem(index, size)
      if (row.isConnected && list.contains(row)) virtualizer.measureElement(row)
    }
  } finally {
    rows.forEach(row => initialBounds.delete(row))
  }
}
