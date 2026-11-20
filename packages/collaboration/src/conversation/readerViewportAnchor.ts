import { getDistanceFromTop } from './conversationViewportScroll'
import {
  createUserViewportAnchor,
  findUserViewportAnchor,
  getMaximumScrollOffset,
  getTextOffsetRect,
} from './conversationScrollGeometry'
import {
  getConversationDiagnosticContext,
  recordConversationScrollDiagnostic as recordScrollDiagnostic,
} from './conversationDiagnostics'
import { startConversationFrameProbe, stopConversationFrameProbe } from './conversationFrameProbe'
import {
  CONVERSATION_SCROLL_WRITE_SOURCE,
  recordConversationScrollWrite,
} from './conversationScrollWrite'
import type { UserViewportAnchor } from './scrollableMessageTypes'

export interface ReaderViewportState {
  anchor: UserViewportAnchor | null
  selfScrollOffset: number
  lastMeasuredLayout: string | null
  lastScrollPosition: number | null
}

export function createReaderViewportAnchor(
  readScroller: () => HTMLElement | null,
  readContent: () => HTMLElement | null,
  state: ReaderViewportState
) {
  const readProbeState = () => ({
    anchor: state.anchor,
    userSelfOffset: state.selfScrollOffset,
  })

  // Records where the reader is looking, together with the scroll offset that position belongs to.
  // A transient layout state can leave nothing on screen; that must not erase the position the
  // reader last chose, so an empty capture is dropped instead of replacing a usable one.
  const captureUserViewportAnchor = () => {
    const scroller = readScroller()
    const content = readContent()
    if (!scroller || !content) return
    const anchor = createUserViewportAnchor(scroller, content)
    recordScrollDiagnostic('anchor-sample', scroller, {
      sampled: anchor !== null,
      anchorIndex: anchor?.anchorIndex ?? null,
      anchorOffset: anchor?.offsetFromScrollerTop ?? null,
    })
    if (!anchor) return
    state.selfScrollOffset = 0
    state.anchor = anchor
    startConversationFrameProbe(scroller, readProbeState)
  }

  // With overflow-anchor:none, Chromium preserves scrollTop across content and viewport resizing.
  // Only our own writes and the native range clamp must be excluded from the reader's movement.
  const clampReaderScrollRange = (maximumOffset: number): number => {
    const anchor = state.anchor
    if (!anchor) return 0
    const believedScrollTop = anchor.scrollTopPx + state.selfScrollOffset
    // A shrinking layout removes offsets the sample used to have. Record that range before
    // a placeholder can grow it again, so native clamping never becomes reader movement.
    const clampedScrollTop = Math.min(maximumOffset, Math.max(0, believedScrollTop))
    state.selfScrollOffset += clampedScrollTop - believedScrollTop
    return clampedScrollTop
  }

  const captureNativeScrollRange = () => {
    const scroller = readScroller()
    if (scroller) clampReaderScrollRange(getMaximumScrollOffset(scroller))
  }

  const readReaderScrollOffsetSinceAnchor = (
    scroller: HTMLElement,
    maximumOffset: number
  ): number =>
    state.anchor ? scroller.scrollTop - clampReaderScrollRange(maximumOffset) : scroller.scrollTop

  // With native anchoring disabled, correction = ΔanchorOffset + ΔreaderScrollTop.
  // Pure reader motion cancels out because moving scrollTop by x moves text by -x
  // in either origin. The remainder is the layout shift to return to the reader.
  const restoreReaderPositionFromLayout = () => {
    const scroller = readScroller()
    const content = readContent()
    const anchor = state.anchor
    if (!scroller || !content || !anchor) {
      return
    }

    const anchorElement = findUserViewportAnchor(content, anchor)
    if (!anchorElement) {
      recordScrollDiagnostic('anchor-lost', scroller, {
        anchorIndex: anchor.anchorIndex,
        previousAnchorOffset: anchor.offsetFromScrollerTop,
      })
      // Nothing on screen from the last sample can be measured, so this layout change cannot be
      // attributed. Re-sample instead of guessing.
      captureUserViewportAnchor()
      return
    }
    anchor.element = anchorElement
    const anchorRect =
      anchor.textOffset === null
        ? anchorElement.getBoundingClientRect()
        : (getTextOffsetRect(anchorElement, anchor.textOffset) ??
          anchorElement.getBoundingClientRect())

    const anchorOffset = anchorRect.top - scroller.getBoundingClientRect().top
    const previousAnchorOffset = anchor.offsetFromScrollerTop
    const readerScrollTop = readReaderScrollOffsetSinceAnchor(
      scroller,
      getMaximumScrollOffset(scroller)
    )
    const correction = anchorOffset - previousAnchorOffset + readerScrollTop
    // Fold reader movement into the same semantic anchor before recording our correction.
    // Otherwise a sample at the range boundary can make our own write appear out of range,
    // discard it on the next measurement, and apply the same layout correction twice.
    anchor.scrollTopPx += readerScrollTop
    anchor.offsetFromScrollerTop -= readerScrollTop
    const layout = `${Math.round(getMaximumScrollOffset(scroller))}:${scroller.clientWidth}:${scroller.clientHeight}`
    // A layout this rule has not measured yet counts as still moving: the first frame of a re-layout is
    // exactly the one that used to hand the reader a position taken in the middle of it.
    const layoutChanged = state.lastMeasuredLayout !== layout
    state.lastMeasuredLayout = layout
    if (Math.abs(correction) < 1) {
      recordScrollDiagnostic('anchor-correction', scroller, {
        ...getConversationDiagnosticContext(anchorElement),
        anchorOffset,
        previousAnchorOffset,
        readerScrollTop,
        correction,
        appliedCorrection: 0,
        layoutChanged,
      })
      // The sampled text is already back where it was, so the sample describes the settled layout — but
      // only once that layout has stopped moving. A pane re-laid out beside the conversation re-wraps its
      // messages over several frames, and replacing the sample between two of them would read the shift
      // that is still coming as the position the reader chose.
      if (!layoutChanged) {
        captureUserViewportAnchor()
      }
      return
    }
    const previousScrollTop = scroller.scrollTop
    let appliedScrollTop = 0
    recordConversationScrollWrite(
      scroller,
      CONVERSATION_SCROLL_WRITE_SOURCE.contentPosition,
      previousScrollTop + correction,
      () => {
        scroller.scrollTop = previousScrollTop + correction
        appliedScrollTop = scroller.scrollTop - previousScrollTop
        // Offset observers can synchronously measure again after this write.
        state.selfScrollOffset += appliedScrollTop
        state.lastScrollPosition = getDistanceFromTop(scroller)
      }
    )
    recordScrollDiagnostic('anchor-correction', scroller, {
      ...getConversationDiagnosticContext(anchorElement),
      anchorOffset,
      previousAnchorOffset,
      readerScrollTop,
      correction,
      appliedCorrection: appliedScrollTop,
      layoutChanged,
    })
    // The browser clamps a write whose offset has no range yet: a transient layout (a row measured
    // before the scroller's own range caught up) cannot put the text back, so this sample still owns
    // the reader's position. Counting the write we did apply keeps the reader's own scrolling
    // separable, and keeping the sample lets the next layout change finish the correction instead of
    // adopting the clamped position as the one the reader chose.
    if (Math.abs(appliedScrollTop - correction) < 1 && !layoutChanged) {
      // The reader is settled again where this sample was taken, so the next layout change has to
      // measure from here rather than from a baseline that already includes this correction.
      captureUserViewportAnchor()
    }
  }

  return {
    captureUserViewportAnchor,
    captureNativeScrollRange,
    restoreReaderPositionFromLayout,
    dispose: () => stopConversationFrameProbe(readProbeState),
  }
}
