import { getScrollViewportElement } from './scrollViewportElement'
export { setConversationFrameProbeEnabled } from './conversationFrameProbe'

// Capture only the layout window around reader input; idle rendering does no diagnostic DOM reads.
const CAPTURE_WINDOW_MS = 10_000
const MAX_EVENTS = 400
const SAFE_DETAIL_KEYS = new Set([
  'scrollerId',
  'rowIndex',
  'chunkIndex',
  'contentLength',
  'lineCount',
  'eager',
  'nearViewport',
  'rendered',
  'reservedHeight',
  'retainedHeight',
  'height',
  'previousHeight',
  'heightDelta',
  'width',
  'intersection',
  'elapsedMs',
  'rootHeight',
  'intersectionHeight',
  'targetTop',
  'scrollerTop',
  'scrollerHeight',
  'previousSize',
  'measuredSize',
  'sizeDelta',
  'totalSize',
  'rowStart',
  'rowEnd',
  'rangeStart',
  'rangeEnd',
  'renderedCount',
  'scrollTop',
  'scrollHeight',
  'clientHeight',
  'clientWidth',
  'scrolling',
  'estimatedSize',
  'deltaY',
  'bottomOrigin',
  'paused',
  'hasAnchor',
  'anchorIndex',
  'anchorOffset',
  'previousAnchorOffset',
  'readerScrollTop',
  'correction',
  'appliedCorrection',
  'layoutChanged',
  'sampled',
  'streaming',
  'frameTimeMs',
  'connected',
  'anchorNodeId',
  'textOffset',
  'textRectFound',
  'anchorTop',
  'anchorHeight',
  'sampledAnchorOffset',
  'sampledScrollTop',
  'selfScrollOffset',
  'rangeClampOffset',
  'expectedAnchorOffset',
  'frameShift',
  'trackedNodeId',
  'trackedTextOffset',
  'trackedConnected',
  'trackedTextRectFound',
  'trackedRowIndex',
  'samePoint',
  'trackedAnchorOffset',
  'previousFrameAnchorOffset',
  'frameScrollTopDelta',
  'frameLayoutShift',
  'writeSource',
  'previousScrollTop',
  'targetScrollTop',
  'lastWheelDeltaY',
  'lastWheelAgeMs',
  'reportedOffset',
  'virtualOffset',
  'rawScrollOffset',
  'virtualScrollOffset',
  'virtualMaximumOffset',
  'nativeMaximumOffset',
])

export type ConversationDiagnosticEventName =
  | 'scroll-input'
  | 'scroll-position'
  | 'anchor-sample'
  | 'anchor-lost'
  | 'anchor-correction'
  | 'anchor-frame'
  | 'scroll-write'
  | 'virtual-scroll-offset'
  | 'layout-change'
  | 'virtual-measurement'
  | 'virtual-range'
  | 'markdown-intersection'
  | 'markdown-layout'
  | 'markdown-unmounted'

export interface ConversationDiagnosticEvent {
  sequence: number
  timestampUnixMs: number
  elapsedMs: number
  name: ConversationDiagnosticEventName
  details: Record<string, number | boolean | null>
}

const events: ConversationDiagnosticEvent[] = []
let captureUntil = 0
let nextSequence = 1
let nextEventIndex = 0
let droppedEventCount = 0
let startedAt = performance.now()
let startedAtUnixMs = Date.now()
let scrollerIds = new WeakMap<Element, number>()
let nextScrollerId = 1
let wheelInputs = new WeakMap<HTMLElement, { deltaY: number; timeMs: number }>()

export function startConversationDiagnosticCapture(): void {
  captureUntil = performance.now() + CAPTURE_WINDOW_MS
}

export function isConversationDiagnosticsEnabled(): boolean {
  return performance.now() < captureUntil
}

export const getConversationDiagnosticScroller = getScrollViewportElement

export function getConversationDiagnosticWheelInput(scroller: HTMLElement): {
  lastWheelDeltaY: number | null
  lastWheelAgeMs: number | null
} {
  const input = wheelInputs.get(scroller)
  return {
    lastWheelDeltaY: input?.deltaY ?? null,
    lastWheelAgeMs: input ? performance.now() - input.timeMs : null,
  }
}

export function getConversationDiagnosticContext(element: Element | null): {
  scrollerId: number
  rowIndex: number
} {
  const scroller = getConversationDiagnosticScroller(element)
  let scrollerId = scroller ? scrollerIds.get(scroller) : 0
  if (scroller && scrollerId === undefined) {
    scrollerId = nextScrollerId++
    scrollerIds.set(scroller, scrollerId)
  }
  const index = element?.closest<HTMLElement>('[data-index]')?.dataset.index
  const rowIndex = index === undefined ? -1 : Number(index)
  return {
    scrollerId: scrollerId ?? 0,
    rowIndex: Number.isInteger(rowIndex) ? rowIndex : -1,
  }
}

export function recordConversationDiagnostic(
  name: ConversationDiagnosticEventName,
  details: Record<string, unknown> = {}
): void {
  if (!isConversationDiagnosticsEnabled()) return
  const sanitized: ConversationDiagnosticEvent['details'] = {}
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue
    if (value === null || typeof value === 'boolean') sanitized[key] = value
    if (typeof value === 'number' && Number.isFinite(value)) sanitized[key] = round(value)
  }
  const event = {
    sequence: nextSequence++,
    timestampUnixMs: Date.now(),
    elapsedMs: round(performance.now() - startedAt),
    name,
    details: sanitized,
  }
  if (events.length < MAX_EVENTS) {
    events.push(event)
  } else {
    events[nextEventIndex] = event
    nextEventIndex = (nextEventIndex + 1) % MAX_EVENTS
    droppedEventCount++
  }
}

export function getConversationDiagnosticsSnapshot() {
  if (events.length === 0) return null
  const ordered =
    nextEventIndex === 0
      ? events
      : [...events.slice(nextEventIndex), ...events.slice(0, nextEventIndex)]
  return {
    schemaVersion: 1 as const,
    capturedAtUnixMs: Date.now(),
    sessionStartedAtUnixMs: startedAtUnixMs,
    captureWindowMs: CAPTURE_WINDOW_MS,
    droppedEventCount,
    events: ordered.map(event => ({
      ...event,
      details: { ...event.details },
    })),
  }
}

export function recordConversationScrollDiagnostic(
  name: ConversationDiagnosticEventName,
  scroller: HTMLElement | null,
  details: Record<string, unknown>
): void {
  if (!scroller || !isConversationDiagnosticsEnabled()) return
  if (
    name === 'scroll-input' &&
    typeof details.deltaY === 'number' &&
    Number.isFinite(details.deltaY)
  ) {
    // Both the pane and its external viewport can receive the same wheel event. Keep only the
    // latest direction, rather than accumulating deltas that would count such input twice.
    wheelInputs.set(scroller, {
      deltaY: details.deltaY,
      timeMs: performance.now(),
    })
  }
  recordConversationDiagnostic(name, {
    ...getConversationDiagnosticContext(scroller),
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    clientWidth: scroller.clientWidth,
    ...details,
  })
}

export function resetConversationDiagnosticsForTest(): void {
  events.splice(0)
  captureUntil = 0
  nextSequence = 1
  nextEventIndex = 0
  droppedEventCount = 0
  startedAt = performance.now()
  startedAtUnixMs = Date.now()
  scrollerIds = new WeakMap()
  nextScrollerId = 1
  wheelInputs = new WeakMap()
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
