import type { RefObject } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { MarkdownWindowingScope } from '../markdown/MarkdownWindowingScope'
import {
  cacheConversationVirtualMeasurements,
  type VirtualMeasurementLayout,
} from './conversationViewportCache'
import type { ConversationVirtualizer } from './useConversationVirtualizer'
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
  measurementKey: string | null
  measurementLayout: VirtualMeasurementLayout
  virtualizer: ConversationVirtualizer
  rows: readonly VirtualItem[]
  totalSize: number
  searchMessageId?: string
  scrollElementRef?: RefObject<HTMLDivElement | null>
  measureRow(row: HTMLElement): void
  measureRows(rows: HTMLElement[]): void
  onLayoutChange?(): void
}
interface MeasurementSnapshot {
  key: string
  layout: VirtualMeasurementLayout
  rows: VirtualItem[]
}

/** The committed virtualized DOM owns row measurements and its restorable viewport snapshot. */
export function createMessageListViewportPort() {
  let element: HTMLDivElement | null = null
  let input: ViewportInput | null = null
  let lease: symbol | null = null
  let previousLayoutKey: string | null = null
  let previousScrollHeight: number | undefined
  let measurements: MeasurementSnapshot | null = null
  const uncacheable = new Set<string>()
  const pending = new Map<MarkdownWindowingScope, Set<HTMLElement>>()
  const attached = () => lease !== null && element !== null
  function persist() {
    if (measurements)
      cacheConversationVirtualMeasurements(measurements.key, measurements.rows, measurements.layout)
  }
  function capture() {
    if (!input?.ready || !element) return
    element.querySelectorAll<HTMLElement>('[data-message-row][data-index]').forEach(row => {
      const id = row.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId
      if (!id) return
      if (
        row.querySelector('[aria-expanded="true"], [data-testid="user-message-editor"]') ||
        id === input?.searchMessageId
      )
        uncacheable.add(id)
      else uncacheable.delete(id)
    })
    if (!input.virtual || !input.virtualizer.options.enabled || input.measurementKey === null)
      return
    measurements = {
      key: input.measurementKey,
      layout: input.measurementLayout,
      rows: input.virtualizer.takeSnapshot().filter(item => !uncacheable.has(String(item.key))),
    }
  }
  function chunkLayout(scope: MarkdownWindowingScope, chunk: HTMLElement) {
    if (!attached() || input?.scope !== scope) {
      const chunks = pending.get(scope) ?? new Set<HTMLElement>()
      chunks.add(chunk)
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
    if (!input.ready || !input.onLayoutChange) return
    const scrollHeight = input.scrollElementRef?.current?.scrollHeight
    if (scrollHeight === undefined || scrollHeight === previousScrollHeight) return
    // Markdown can restore a clamped native range without changing the cached
    // virtual row sizes. Reconcile the viewport in this DOM commit as well.
    previousScrollHeight = scrollHeight
    input.onLayoutChange()
  }
  return {
    chunkLayout,
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
      if (
        input &&
        (input.measurementKey !== next.measurementKey ||
          input.virtual !== next.virtual ||
          input.virtualizer !== next.virtualizer)
      ) {
        persist()
        measurements = null
        uncacheable.clear()
      }
      input = next
      if (!next.virtual || next.ready) {
        const chunks = [...(pending.get(next.scope) ?? [])]
        pending.clear()
        chunks.forEach(chunk => chunkLayout(next.scope, chunk))
      }
      if (next.ready && previousLayoutKey !== next.layoutKey) {
        const previous = previousLayoutKey
        previousLayoutKey = next.layoutKey
        if (previous !== null) {
          next.virtualizer.measure()
          next.measureRows(
            Array.from(node.querySelectorAll<HTMLElement>('[data-message-row][data-index]'))
          )
        }
      }
      capture()
      if (layoutChanged && next.virtual && next.ready) {
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
            scrollTop: scroller?.scrollTop,
            scrollHeight: scroller?.scrollHeight,
            clientHeight: scroller?.clientHeight,
            clientWidth: scroller?.clientWidth,
            scrolling: next.virtualizer.isScrolling,
          })
        }
        next.onLayoutChange?.()
      }
    },
  }
}
