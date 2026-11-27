import { useCallback, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { flushSync } from 'react-dom'
import type { ConversationVirtualizer } from './useConversationVirtualizer'
import type { VirtualMessageMeasurement } from './MessageList'
import {
  cancelSafeAnimationFrame,
  requestSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from '../markdown/safeAnimationFrame'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'

const initialBounds = new WeakMap<HTMLElement, DOMRect>()
const MEASUREMENT_FRAME_BUDGET_MS = 8
const MEASUREMENT_RUN_GAP_MS = 100
const MEASUREMENT_WARNING_AFTER_MS = 2000
const MEASUREMENT_WARNING_INTERVAL_MS = 30000

/** TanStack owns the observer, resize batching, and the only size writer. */
export function useMessageRowMeasure(
  onMeasurement?: (measurement: VirtualMessageMeasurement) => void,
  onMeasured?: (row: HTMLElement, width: number, size: number) => void,
  layoutWidth?: number
) {
  return useCallback(
    (
      row: HTMLElement,
      entry: ResizeObserverEntry | undefined,
      virtualizer: ConversationVirtualizer
    ) => {
      const index = Number(row.dataset.index)
      const item = virtualizer.getVirtualItems().find(item => item.index === index)
      const observedBorder = entry?.borderBoxSize?.[0]
      // TanStack can deliver resize entries in the next animation frame.
      // A prior column width must not overwrite the newly measured row.
      const border =
        layoutWidth && observedBorder && Math.round(observedBorder.inlineSize) !== layoutWidth
          ? undefined
          : observedBorder
      const rect = border ? null : (initialBounds.get(row) ?? row.getBoundingClientRect())
      const width = border?.inlineSize ?? rect!.width
      const height = border?.blockSize ?? rect!.height
      const measuredSize = Math.round(height)
      if (width <= 0 || height <= 0) return item?.size ?? virtualizer.options.estimateSize(index)
      // Entries are delivered through rAF and may describe a placeholder that
      // has since rendered real Markdown, even at the same width. Only a live
      // DOM read may certify the geometry for conversation restoration.
      if (!border) onMeasured?.(row, width, measuredSize)
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
    [onMeasurement, onMeasured, layoutWidth]
  )
}

interface MeasurementBatch {
  rows: Set<HTMLElement>
  completions: Set<() => void>
}

export function useMessageRowMeasurements(
  listRef: RefObject<HTMLDivElement | null>,
  virtualizer: ConversationVirtualizer,
  enabled: boolean
) {
  const pending = useRef<MeasurementBatch | null>(null)
  const scheduledFrame = useRef<SafeAnimationFrameHandle | null>(null)
  const measurementRun = useRef({
    startedAt: 0,
    lastBatchAt: 0,
    batches: 0,
    lastWarningAt: -Infinity,
  })
  const initializedList = useRef<HTMLDivElement | null>(null)
  const measureRows = useCallback(
    (rows: HTMLElement[], onComplete?: () => void) => {
      if (!enabled) return
      const queued = pending.current
      if (queued) {
        rows.forEach(row => queued.rows.add(row))
        if (onComplete) queued.completions.add(onComplete)
        return
      }
      const batch: MeasurementBatch = {
        rows: new Set(rows),
        completions: new Set(onComplete ? [onComplete] : []),
      }
      pending.current = batch
      const run = measurementRun.current
      const now = performance.now()
      if (now - run.lastBatchAt > MEASUREMENT_RUN_GAP_MS || run.startedAt === 0) {
        run.startedAt = now
        run.batches = 0
      }
      let frameStartedAt: number
      // New rows can enter the range after every measurement. Finish the React
      // commit before publishing sizes, then yield between batches when needed.
      const measureBatch = () => {
        if (pending.current !== batch) return
        const list = listRef.current
        if (!list?.isConnected || !virtualizer.options.enabled) {
          pending.current = null
          return
        }
        const attached = [...batch.rows].filter(row => list.contains(row))
        batch.rows.clear()
        if (attached.length) {
          const totalSizeBefore = virtualizer.getTotalSize()
          const scrollOffsetBefore = virtualizer.scrollOffset
          flushSync(() => {
            if (batch.completions.size === 0) {
              measureAttachedRows(attached, list, virtualizer)
              return
            }
            // A column resize has one viewport correction after all row
            // sizes commit. Disable per-row compensation so TanStack's
            // notifications can also commit together in this flush.
            const adjust = virtualizer.shouldAdjustScrollPositionOnItemSizeChange
            const threshold = virtualizer.options.scrollEndThreshold
            virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
            virtualizer.setOptions({
              ...virtualizer.options,
              scrollEndThreshold: -1,
            })
            try {
              measureAttachedRows(attached, list, virtualizer)
            } finally {
              virtualizer.shouldAdjustScrollPositionOnItemSizeChange = adjust
              virtualizer.setOptions({
                ...virtualizer.options,
                scrollEndThreshold: threshold,
              })
            }
          })
          run.lastBatchAt = performance.now()
          run.batches++
          if (
            run.lastBatchAt - run.startedAt >= MEASUREMENT_WARNING_AFTER_MS &&
            run.lastBatchAt - run.lastWarningAt >= MEASUREMENT_WARNING_INTERVAL_MS
          ) {
            run.lastWarningAt = run.lastBatchAt
            console.warn(
              '[Wework] Conversation row measurement diagnostic ' +
                JSON.stringify({
                  durationMs: Math.round(run.lastBatchAt - run.startedAt),
                  batches: run.batches,
                  rows: attached.length,
                  firstIndex: Number(attached[0].dataset.index),
                  lastIndex: Number(attached[attached.length - 1].dataset.index),
                  itemCount: virtualizer.options.count,
                  scrollOffsetBefore,
                  scrollOffsetAfter: virtualizer.scrollOffset,
                  totalSizeBefore,
                  totalSizeAfter: virtualizer.getTotalSize(),
                })
            )
          }
        }
        if (pending.current !== batch) return
        // Measurements can expose more rows in the synchronous commit. Keep the
        // same batch open until those rows have also been measured.
        if (batch.rows.size > 0) {
          scheduleBatch()
          return
        }
        pending.current = null
        batch.completions.forEach(complete => complete())
      }
      const beginFrame = () => {
        if (pending.current !== batch) return
        scheduledFrame.current = null
        frameStartedAt = performance.now()
        measureBatch()
      }
      const scheduleBatch = () => {
        if (performance.now() - frameStartedAt >= MEASUREMENT_FRAME_BUDGET_MS) {
          scheduledFrame.current = requestSafeAnimationFrame(beginFrame)
        } else queueMicrotask(measureBatch)
      }
      queueMicrotask(beginFrame)
    },
    [enabled, listRef, virtualizer]
  )

  useLayoutEffect(
    () => () => {
      pending.current = null
      if (scheduledFrame.current) cancelSafeAnimationFrame(scheduledFrame.current)
      scheduledFrame.current = null
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
    // Cached rows already have geometry for this layout. Give their Markdown
    // time to mount before replacing those measurements with the current DOM.
    const unmeasured: HTMLElement[] = []
    const cached: HTMLElement[] = []
    for (const row of changed) {
      const key = virtualizer.options.getItemKey(Number(row.dataset.index))
      const batch = virtualizer.itemSizeCache.has(key) ? cached : unmeasured
      batch.push(row)
    }
    if (cached.length > 0) measureRows(cached)
    // Measure uncached rows in their first commit. Any newly exposed range
    // follows the normal batched path to avoid recursive React updates.
    if (unmeasured.length > 0) measureAttachedRows(unmeasured, list, virtualizer)
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
    const attached = rows.filter(row => row.isConnected && list.contains(row))
    // Register the complete batch before resizing, since resizeItem can commit
    // React synchronously and expose a partially registered row range.
    attached.forEach(row => virtualizer.measureElement(row))
    for (const row of attached) {
      // TanStack skips synchronous measurement during native scrolling. Commit
      // the current DOM size before paint while ongoing observation stays active.
      const index = Number(row.dataset.index)
      const size = virtualizer.options.measureElement(row, undefined, virtualizer)
      const item = virtualizer.getVirtualItems().find(item => item.index === index)
      if (item && item.size !== size) virtualizer.resizeItem(index, size)
    }
  } finally {
    rows.forEach(row => initialBounds.delete(row))
  }
}
