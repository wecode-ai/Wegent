import type { RefObject } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { MarkdownWindowingScope } from '../markdown/MarkdownWindowingScope'
import {
  cacheConversationVirtualMeasurements,
  getConversationVirtualMeasurements,
  type VirtualMeasurementLayout,
} from './conversationViewportCache'
import type { ConversationVirtualizer } from './useConversationVirtualizer'
import type { ConversationLayoutChangeReason } from './scrollableMessageTypes'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'

interface ViewportInput {
  scope: MarkdownWindowingScope
  virtual: boolean
  ready: boolean
  layoutKey: string
  layoutWidth: number
  layoutPropertiesKey: string
  measurementKey: string | null
  measurementLayout: VirtualMeasurementLayout
  virtualizer: ConversationVirtualizer
  rows: readonly VirtualItem[]
  totalSize: number
  searchMessageId?: string
  scrollElementRef?: RefObject<HTMLDivElement | null>
  measureRow(row: HTMLElement): void
  measureRows(rows: HTMLElement[], onComplete?: () => void): void
  onLayoutChange?(reason?: ConversationLayoutChangeReason): void
}
interface MeasurementSnapshot {
  key: string
  layout: VirtualMeasurementLayout
  width: number
  rows: VirtualItem[]
}

interface RowMeasurement {
  layoutKey: string
  width: number
  signature: string
  size: number
}

function isTransientRow(
  row: HTMLElement,
  id: string,
  layoutWidth: number,
  searchMessageId?: string
): boolean {
  return Boolean(
    id === searchMessageId ||
    row.querySelector(
      `[aria-expanded="true"], [data-testid="user-message-editor"], [data-markdown-window-placeholder]:not([data-markdown-placeholder-row-width="${layoutWidth}"])`
    )
  )
}

/** The committed virtualized DOM owns row measurements and its restorable viewport snapshot. */
export function createMessageListViewportPort() {
  let element: HTMLDivElement | null = null
  let input: ViewportInput | null = null
  let lease: symbol | null = null
  let previousLayout: Pick<
    ViewportInput,
    'layoutKey' | 'layoutWidth' | 'layoutPropertiesKey'
  > | null = null
  let pendingResize: symbol | null = null
  let previousScrollHeight: number | undefined
  let measurements: MeasurementSnapshot | null = null
  const recordedRows = new Map<string, RowMeasurement>()
  const uncacheable = new Set<string>()
  const pending = new Map<MarkdownWindowingScope, Map<HTMLElement, boolean>>()
  const attached = () => lease !== null && element !== null
  function persist() {
    if (!measurements) return
    const { key, layout, width, rows } = measurements
    // Measurement eligibility can change without a virtual size delta or a
    // parent commit. Revalidate the last snapshot against current provenance.
    cacheConversationVirtualMeasurements(
      key,
      rows.filter(item => {
        const id = String(item.key)
        const recorded = recordedRows.get(id)
        return (
          !uncacheable.has(id) &&
          recorded?.layoutKey === layout.key &&
          recorded.width === width &&
          recorded.signature === layout.messages.get(id) &&
          recorded.size === item.size
        )
      }),
      layout
    )
  }
  function restoreMeasurements(next: ViewportInput) {
    if (next.measurementKey === null || !next.ready) return
    const restored = getConversationVirtualMeasurements(next.measurementKey, next.measurementLayout)
    restored?.forEach(item => {
      const id = String(item.key)
      const signature = next.measurementLayout.messages.get(id)
      if (signature === undefined || recordedRows.has(id)) return
      recordedRows.set(id, {
        layoutKey: next.layoutKey,
        width: next.layoutWidth,
        signature,
        size: item.size,
      })
    })
  }
  function capture() {
    if (!input?.ready || !element) return
    const { layoutWidth, searchMessageId } = input
    element.querySelectorAll<HTMLElement>('[data-message-row][data-index]').forEach(row => {
      const id = row.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId
      if (!id) return
      if (isTransientRow(row, id, layoutWidth, searchMessageId)) {
        uncacheable.add(id)
        recordedRows.delete(id)
      } else uncacheable.delete(id)
    })
    if (!input.virtual || !input.virtualizer.options.enabled || input.measurementKey === null)
      return
    const { measurementLayout, measurementKey, virtualizer } = input
    measurements = {
      key: measurementKey,
      layout: measurementLayout,
      width: layoutWidth,
      // Live virtual geometry may still include offscreen sizes from the old
      // width. Persist only rows whose measurements remain verified.
      rows: virtualizer.takeSnapshot(),
    }
  }
  function chunkLayout(scope: MarkdownWindowingScope, chunk: HTMLElement, materialized = false) {
    if (!attached() || input?.scope !== scope) {
      const chunks = pending.get(scope) ?? new Map<HTMLElement, boolean>()
      chunks.set(chunk, materialized || chunks.get(chunk) === true)
      pending.set(scope, chunks)
      return
    }
    if (!element?.contains(chunk)) return
    if (!input.virtual) {
      input.onLayoutChange?.()
      return
    }
    const row = chunk.closest<HTMLElement>('[data-message-row][data-index]')
    if (!row || !element.contains(row)) return
    input.measureRow(row)
    if (!input.ready || !input.onLayoutChange || pendingResize !== null) return
    const scrollHeight = input.scrollElementRef?.current?.scrollHeight
    if (scrollHeight === undefined) return
    if (scrollHeight === previousScrollHeight) {
      // A placeholder can reveal the saved paragraph without changing the native range.
      if (materialized && !chunk.firstElementChild?.matches('[data-markdown-window-placeholder]'))
        input.onLayoutChange({ materializedChunk: chunk })
      return
    }
    // Markdown can restore a clamped native range without changing the cached
    // virtual row sizes. Reconcile the viewport in this DOM commit as well.
    previousScrollHeight = scrollHeight
    input.onLayoutChange()
  }
  return {
    chunkLayout,
    recordMeasurement(
      row: HTMLElement,
      width: number,
      size: number,
      layoutWidth: number,
      layout: VirtualMeasurementLayout
    ) {
      // Native row notifications may arrive for the width preceding this
      // commit. Never certify their heights for the new width.
      if (
        !element?.contains(row) ||
        layoutWidth <= 0 ||
        Math.round(width) !== layoutWidth ||
        !Number.isFinite(size) ||
        size <= 0
      )
        return
      const id = row.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId
      if (!id) return
      const signature = layout.messages.get(id)
      if (signature === undefined) return
      if (isTransientRow(row, id, layoutWidth, input?.searchMessageId)) {
        uncacheable.add(id)
        recordedRows.delete(id)
        return
      }
      uncacheable.delete(id)
      recordedRows.set(id, {
        layoutKey: layout.key,
        width: layoutWidth,
        signature,
        size,
      })
    },
    attach(node: HTMLDivElement) {
      const binding = Symbol('message-list-viewport')
      lease = binding
      element = node
      return () => {
        if (lease !== binding) return
        lease = null
        queueMicrotask(() => {
          if (lease !== null) return
          persist()
          element = null
          input = null
          pendingResize = null
          recordedRows.clear()
          pending.clear()
        })
      }
    },
    update(next: ViewportInput) {
      const node = element
      if (!node || !attached()) return
      const layoutChanged =
        !input ||
        input.scope !== next.scope ||
        input.virtualizer !== next.virtualizer ||
        input.onLayoutChange !== next.onLayoutChange ||
        input.scrollElementRef !== next.scrollElementRef ||
        input.virtual !== next.virtual ||
        input.ready !== next.ready ||
        input.rows !== next.rows ||
        input.totalSize !== next.totalSize
      const ownerChanged = Boolean(
        input &&
        (input.measurementKey !== next.measurementKey ||
          input.virtual !== next.virtual ||
          input.virtualizer !== next.virtualizer)
      )
      // Initial measurements can arrive before the virtualizer has committed
      // any rows. The first usable column is initialization, not a resize of
      // an existing viewport (for example when a restored pane docks a panel).
      const activeLayout = next.ready && next.virtualizer.options.enabled && next.rows.length > 0
      if (!activeLayout) previousLayout = null
      const previousWidth = previousLayout?.layoutWidth
      const nextLayout = activeLayout && previousLayout?.layoutKey !== next.layoutKey
      const widthOnly =
        nextLayout &&
        !ownerChanged &&
        previousLayout !== null &&
        previousLayout.layoutWidth !== next.layoutWidth &&
        previousLayout.layoutPropertiesKey === next.layoutPropertiesKey
      if (
        ownerChanged ||
        (next.ready && measurements && measurements.layout.key !== next.layoutKey)
      ) {
        persist()
        measurements = null
      }
      if (ownerChanged) {
        recordedRows.clear()
        uncacheable.clear()
      }
      if (ownerChanged || !activeLayout || (nextLayout && !widthOnly)) pendingResize = null
      const resize = widthOnly ? Symbol('message-list-resize') : null
      if (resize !== null) pendingResize = resize
      if (!input || ownerChanged || (next.ready && !input.ready)) restoreMeasurements(next)
      input = next
      if (!next.virtual || next.ready) {
        const chunks = pending.get(next.scope)
        pending.clear()
        chunks?.forEach((materialized, chunk) => chunkLayout(next.scope, chunk, materialized))
      }
      if (nextLayout) {
        const previous = previousLayout
        previousLayout = {
          layoutKey: next.layoutKey,
          layoutWidth: next.layoutWidth,
          layoutPropertiesKey: next.layoutPropertiesKey,
        }
        if (previous !== null) {
          const rows = Array.from(
            node.querySelectorAll<HTMLElement>('[data-message-row][data-index]')
          )
          if (resize !== null) {
            next.measureRows(rows, () => {
              if (pendingResize !== resize || !input?.ready || !attached()) return
              pendingResize = null
              capture()
              input.onLayoutChange?.('resize')
            })
          } else {
            next.virtualizer.measure()
            next.measureRows(rows)
          }
        }
      }
      if (pendingResize === null) capture()
      if ((layoutChanged || nextLayout) && next.virtual && next.ready) {
        next.scope.getViewportRenders().forEach(render => render())
        // The chunk callback can read the native range when it actually needs it.
        previousScrollHeight = undefined
        if (isConversationDiagnosticsEnabled()) {
          const scroller = next.scrollElementRef?.current
          recordConversationDiagnostic('virtual-range', {
            ...getConversationDiagnosticContext(node),
            rangeStart: next.virtualizer.range?.startIndex,
            rangeEnd: next.virtualizer.range?.endIndex,
            renderedCount: next.rows.length,
            totalSize: next.totalSize,
            width: next.layoutWidth,
            previousWidth,
            virtualizerEnabled: next.virtualizer.options.enabled,
            pendingResize: pendingResize !== null,
            scrollTop: scroller?.scrollTop,
            scrollHeight: scroller?.scrollHeight,
            clientHeight: scroller?.clientHeight,
            clientWidth: scroller?.clientWidth,
            scrolling: next.virtualizer.isScrolling,
          })
        }
        if (pendingResize === null && resize === null) next.onLayoutChange?.()
      }
    },
  }
}
