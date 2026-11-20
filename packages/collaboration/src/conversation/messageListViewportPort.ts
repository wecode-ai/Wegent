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
    capture()
  }
  return {
    chunkLayout,
    bind(node: HTMLDivElement, next: ViewportInput) {
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
      const binding = Symbol('message-list-viewport')
      lease = binding
      element = node
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
      return () => {
        if (lease !== binding) return
        lease = null
        // Persist the last committed owner, even if TanStack has already accepted another scope's options.
        persist()
        queueMicrotask(() => {
          if (lease !== null) return
          element = null
          input = null
          pending.clear()
        })
      }
    },
  }
}
