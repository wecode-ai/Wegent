import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { ConversationVirtualizer } from './useConversationVirtualizer'
import type { VirtualMessageMeasurement } from './MessageList'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'

/** resizeItem is the only writer, for both pre-paint Markdown and observed layout. */
export function useMessageRowMeasurements(
  listRef: RefObject<HTMLDivElement | null>,
  virtualizer: ConversationVirtualizer,
  enabled: boolean,
  onMeasurement?: (measurement: VirtualMessageMeasurement) => void
) {
  const observerRef = useRef<ResizeObserver | null>(null)
  const observed = useRef(new Set<HTMLElement>())
  const measure = useCallback(
    (row: HTMLElement) => {
      if (!enabled || !listRef.current?.contains(row)) return
      const index = Number(row.dataset.index)
      if (!Number.isInteger(index) || index < 0 || index >= virtualizer.options.count) return
      const rect = row.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const measuredSize = Math.round(rect.height)
      const item = virtualizer.getVirtualItems().find(item => item.index === index)
      if (item?.size === measuredSize) return
      const previousTotalSize = virtualizer.getTotalSize()
      if (isConversationDiagnosticsEnabled())
        recordConversationDiagnostic('virtual-measurement', {
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
        })
      virtualizer.resizeItem(index, measuredSize)
      onMeasurement?.({
        messageId: row.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId ?? null,
        previousSize: item?.size ?? null,
        measuredSize,
        previousTotalSize,
        nextTotalSize: virtualizer.getTotalSize(),
      })
    },
    [enabled, listRef, onMeasurement, virtualizer]
  )

  useLayoutEffect(() => {
    if (!enabled) return
    const observer = new ResizeObserver(entries => {
      entries.forEach(entry => measure(entry.target as HTMLElement))
    })
    observerRef.current = observer
    return () => {
      observer.disconnect()
      observerRef.current = null
      observed.current.clear()
    }
  }, [enabled, measure])

  useLayoutEffect(() => {
    if (!enabled) return
    observed.current.forEach(row => {
      if (!listRef.current?.contains(row)) {
        observerRef.current?.unobserve(row)
        observed.current.delete(row)
      }
    })
    listRef.current
      ?.querySelectorAll<HTMLElement>('[data-message-row][data-index]')
      .forEach(row => {
        if (!observed.current.has(row)) {
          observed.current.add(row)
          observerRef.current?.observe(row)
        }
        measure(row)
      })
  })
  return measure
}
