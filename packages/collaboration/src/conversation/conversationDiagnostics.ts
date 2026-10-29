import { getScrollViewportElement } from './scrollViewportElement'
import {
  createConversationSearchPerformanceCapture,
  sanitizeSearchScriptDetail,
} from './conversationSearchPerformance'
export { setConversationFrameProbeEnabled } from './conversationFrameProbe'

// Capture only the layout window around reader input; idle rendering does no diagnostic DOM reads.
const CAPTURE_WINDOW_MS = 10_000
const MAX_EVENTS = 400
// These keys must carry only measurements or flags, never user text.
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
  'queryLength',
  'inputSequence',
  'eventDelayMs',
  'messageCount',
  'matchCount',
  'targetChanged',
  'queryPending',
  'historyLoading',
  'historyIncomplete',
  'historyPending',
  'historyFailed',
  'requestFailed',
  'locationFailed',
  'loading',
  'loadingMoreBefore',
  'startTime',
  'blockingDuration',
  'renderTailMs',
  'styleLayoutTailMs',
  'scriptDuration',
  'scriptCount',
  'forcedStyleAndLayoutDuration',
  'frameStartTime',
  'executionStart',
  'sourceCharPosition',
  'diagramContentId',
  'diagramInstanceId',
  'diagramRenderId',
  'mermaid',
  'darkTheme',
  'fullscreen',
  'failed',
  'timedOut',
  'cacheHit',
  'layoutIsolated',
  'phase',
  'smooth',
  'predictionProviderId',
  'predictionApiId',
  'predictionServiceId',
  'predictionScopeHash',
  'predictionKeyHash',
  'predictionModelHash',
  'predictionModelSemanticHash',
  'predictionTurnHash',
  'ownerCount',
  'eligible',
  'enabled',
  'busy',
  'unmounted',
  'apiChanged',
  'serviceChanged',
  'scopeChanged',
  'keyChanged',
  'busyChanged',
  'requestKeyChanged',
  'taskRemoved',
  'lastOwnerReleased',
  'capacityEviction',
  'aborted',
  'settled',
  'hasSuggestion',
])

export type ConversationDiagnosticEventName =
  | 'search-navigation-phase'
  | 'scroll-input'
  | 'scroll-position'
  | 'anchor-sample'
  | 'anchor-lost'
  | 'anchor-correction'
  | 'anchor-frame'
  | 'scroll-write'
  | 'layout-change'
  | 'virtual-measurement'
  | 'virtual-range'
  | 'markdown-intersection'
  | 'markdown-layout'
  | 'markdown-unmounted'
  | 'search-delete'
  | 'search-input'
  | 'search-debounce'
  | 'search-status'
  | 'search-commit'
  | 'search-frame'
  | 'search-index'
  | 'search-match'
  | 'search-target-commit'
  | 'search-target-effect'
  | 'search-highlights'
  | 'search-layout'
  | 'search-scroll-render'
  | 'search-virtual-render'
  | 'search-navigation-cancel'
  | 'search-long-task'
  | 'search-long-frame'
  | 'search-slow-script'
  | 'search-diagram-activate'
  | 'search-diagram-mount'
  | 'search-diagram-unmount'
  | 'search-diagram-viewer-start'
  | 'search-diagram-viewer-result'
  | 'search-diagram-viewer-stop'
  | 'search-diagram-viewer-timeout'
  | 'reply-prediction-effect-start'
  | 'reply-prediction-effect-cleanup'
  | 'reply-prediction-retain'
  | 'reply-prediction-release'
  | 'reply-prediction-request'
  | 'reply-prediction-invalidate'
  | 'reply-prediction-abort'
  | 'reply-prediction-settled'

export interface ConversationDiagnosticEvent {
  sequence: number
  timestampUnixMs: number
  elapsedMs: number
  name: ConversationDiagnosticEventName
  details: Record<string, number | boolean | string | null>
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
const searchPerformanceCapture = createConversationSearchPerformanceCapture(
  recordConversationDiagnostic,
  CAPTURE_WINDOW_MS
)

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
  if (name === 'search-input' || name === 'search-delete') searchPerformanceCapture.capture()
  const sanitized: ConversationDiagnosticEvent['details'] = {}
  for (const [key, value] of Object.entries(details)) {
    if (
      name.startsWith('reply-prediction-') &&
      (key === 'modelFieldOrder' || key === 'optionFieldOrder') &&
      typeof value === 'string' &&
      value.length <= 1024 &&
      (value === '' || value.split(',').every(field => /^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(field)))
    ) {
      sanitized[key] = value
      continue
    }
    if (name === 'search-slow-script' && typeof value === 'string') {
      const safeValue = sanitizeSearchScriptDetail(key, value)
      if (safeValue !== undefined) sanitized[key] = safeValue
      continue
    }
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
  if (name.startsWith('search-')) {
    // The Electron host persists only this sanitized diagnostic prefix.
    console.info(`[Wework] Conversation search diagnostic ${JSON.stringify(event)}`)
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
  searchPerformanceCapture.stop()
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
