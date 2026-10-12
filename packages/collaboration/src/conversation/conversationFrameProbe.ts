import {
  getConversationDiagnosticContext,
  getConversationDiagnosticWheelInput,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'
import { getTextOffsetRect } from './conversationScrollGeometry'
import type { UserViewportAnchor } from './scrollableMessageTypes'

export interface ConversationFrameProbeState {
  anchor: UserViewportAnchor | null
  userSelfOffset: number
  bottomOrigin: boolean
}

type ReadProbeState = () => ConversationFrameProbeState
interface ProbeTarget {
  scroller: HTMLElement
  readState: ReadProbeState
}
interface TrackedPoint {
  element: HTMLElement
  textOffset: number | null
  offset: number
  scrollTop: number
}

let enabled = false
let target: ProbeTarget | null = null
let frameId: number | null = null
let previousPoint: TrackedPoint | null = null
const nodeIds = new WeakMap<HTMLElement, number>()
let nextNodeId = 1

// This is deliberately opt-in: normal scrolling schedules no probe and reads no extra geometry.
export function setConversationFrameProbeEnabled(value: boolean): void {
  enabled = value
  if (!value) stopConversationFrameProbe()
}

export function startConversationFrameProbe(
  scroller: HTMLElement,
  readState: ReadProbeState
): void {
  if (!enabled || !isConversationDiagnosticsEnabled()) return
  if (target?.scroller !== scroller) previousPoint = null
  target = { scroller, readState }
  if (frameId === null) frameId = requestAnimationFrame(sampleFrame)
}

// A pane's cleanup must not cancel the loop most recently acquired by another pane.
export function stopConversationFrameProbe(readState?: ReadProbeState): void {
  if (readState && target?.readState !== readState) return
  if (frameId !== null) cancelAnimationFrame(frameId)
  frameId = null
  target = null
  previousPoint = null
}

function nodeId(element: HTMLElement): number {
  let id = nodeIds.get(element)
  if (id === undefined) {
    id = nextNodeId++
    nodeIds.set(element, id)
  }
  return id
}

function pointRect(element: HTMLElement, textOffset: number | null) {
  const textRect = textOffset === null ? null : getTextOffsetRect(element, textOffset)
  return {
    rect: textRect ?? element.getBoundingClientRect(),
    textRectFound: textRect !== null,
  }
}

function sampleFrame(frameTimeMs: number): void {
  frameId = null
  if (!enabled || !isConversationDiagnosticsEnabled() || !target?.scroller.isConnected) {
    stopConversationFrameProbe()
    return
  }
  const { scroller, readState } = target
  const { anchor, userSelfOffset, bottomOrigin } = readState()
  const viewport = scroller.getBoundingClientRect()
  const scrollTop = scroller.scrollTop
  const scrollHeight = scroller.scrollHeight
  const clientHeight = scroller.clientHeight
  const maximumOffset = Math.max(0, scrollHeight - clientHeight)
  const connected = Boolean(anchor?.element.isConnected && scroller.contains(anchor.element))
  const currentPoint = anchor && connected ? pointRect(anchor.element, anchor.textOffset) : null
  const anchorOffset = currentPoint ? currentPoint.rect.top - viewport.top : null
  const believedScrollTop = anchor ? anchor.scrollTopPx + userSelfOffset : null
  const clampedScrollTop =
    believedScrollTop === null
      ? null
      : bottomOrigin
        ? Math.min(0, Math.max(-maximumOffset, believedScrollTop))
        : Math.min(maximumOffset, Math.max(0, believedScrollTop))
  const readerScrollTop = clampedScrollTop === null ? null : scrollTop - clampedScrollTop
  const expectedAnchorOffset =
    anchor && readerScrollTop !== null ? anchor.offsetFromScrollerTop - readerScrollTop : null

  // Resampling can choose another line in the same paragraph. Re-measure the previous exact
  // character now, before changing targets; comparing two different characters would invent a shift.
  const trackedConnected = Boolean(
    previousPoint?.element.isConnected && scroller.contains(previousPoint.element)
  )
  const samePoint = Boolean(
    anchor &&
    previousPoint?.element === anchor.element &&
    previousPoint.textOffset === anchor.textOffset
  )
  const trackedRect =
    previousPoint && trackedConnected
      ? samePoint && currentPoint
        ? currentPoint
        : pointRect(previousPoint.element, previousPoint.textOffset)
      : null
  const trackedAnchorOffset = trackedRect ? trackedRect.rect.top - viewport.top : null
  const frameScrollTopDelta = previousPoint ? scrollTop - previousPoint.scrollTop : null
  const frameLayoutShift =
    previousPoint && trackedAnchorOffset !== null && frameScrollTopDelta !== null
      ? trackedAnchorOffset - previousPoint.offset + frameScrollTopDelta
      : null

  recordConversationDiagnostic('anchor-frame', {
    ...getConversationDiagnosticContext(scroller),
    ...getConversationDiagnosticWheelInput(scroller),
    rowIndex: getConversationDiagnosticContext(anchor?.element ?? null).rowIndex,
    frameTimeMs,
    scrollTop,
    scrollHeight,
    clientHeight,
    clientWidth: scroller.clientWidth,
    scrollerTop: viewport.top,
    scrollerHeight: viewport.height,
    bottomOrigin,
    hasAnchor: anchor !== null,
    connected,
    anchorNodeId: anchor ? nodeId(anchor.element) : null,
    anchorIndex: anchor?.anchorIndex ?? null,
    textOffset: anchor?.textOffset ?? null,
    textRectFound: currentPoint?.textRectFound ?? false,
    anchorTop: currentPoint?.rect.top ?? null,
    anchorHeight: currentPoint?.rect.height ?? null,
    anchorOffset,
    sampledAnchorOffset: anchor?.offsetFromScrollerTop ?? null,
    sampledScrollTop: anchor?.scrollTopPx ?? null,
    selfScrollOffset: userSelfOffset,
    rangeClampOffset:
      clampedScrollTop !== null && believedScrollTop !== null
        ? clampedScrollTop - believedScrollTop
        : null,
    readerScrollTop,
    expectedAnchorOffset,
    frameShift:
      anchorOffset !== null && expectedAnchorOffset !== null
        ? anchorOffset - expectedAnchorOffset
        : null,
    trackedNodeId: previousPoint ? nodeId(previousPoint.element) : null,
    trackedTextOffset: previousPoint?.textOffset ?? null,
    trackedConnected,
    trackedTextRectFound: trackedRect?.textRectFound ?? false,
    trackedRowIndex: getConversationDiagnosticContext(previousPoint?.element ?? null).rowIndex,
    samePoint,
    trackedAnchorOffset,
    previousFrameAnchorOffset: previousPoint?.offset ?? null,
    frameScrollTopDelta,
    frameLayoutShift,
  })
  previousPoint =
    anchor && anchorOffset !== null
      ? {
          element: anchor.element,
          textOffset: anchor.textOffset,
          offset: anchorOffset,
          scrollTop,
        }
      : null
  // Reading a frame never renews the reader-input capture deadline.
  if (enabled && isConversationDiagnosticsEnabled()) {
    frameId = requestAnimationFrame(sampleFrame)
  } else {
    stopConversationFrameProbe()
  }
}
