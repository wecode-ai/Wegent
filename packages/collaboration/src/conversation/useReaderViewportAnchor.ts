import { useCallback, useEffect, type RefObject } from 'react'

import { getDistanceFromTop } from './bottomOriginScroll'
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
import type { UserViewportAnchor } from './scrollableMessageTypes'

interface ReaderViewportAnchorOptions {
  activeScrollRefRef: RefObject<RefObject<HTMLElement | null>>
  contentRef: RefObject<HTMLElement | null>
  userViewportAnchorRef: RefObject<UserViewportAnchor | null>
  selfScrollOffsetRef: RefObject<number>
  lastMeasuredLayoutRef: RefObject<string | null>
  lastScrollPositionRef: RefObject<number | null>
  bottomOrigin: boolean
}

export function useReaderViewportAnchor({
  activeScrollRefRef,
  contentRef,
  userViewportAnchorRef,
  selfScrollOffsetRef,
  lastMeasuredLayoutRef,
  lastScrollPositionRef,
  bottomOrigin,
}: ReaderViewportAnchorOptions) {
  const readProbeState = useCallback(
    () => ({
      anchor: userViewportAnchorRef.current,
      userSelfOffset: selfScrollOffsetRef.current,
      bottomOrigin,
    }),
    [bottomOrigin, selfScrollOffsetRef, userViewportAnchorRef]
  )
  useEffect(() => () => stopConversationFrameProbe(readProbeState), [readProbeState])

  // Records where the reader is looking, together with the scroll offset that position belongs to.
  // A transient layout state can leave nothing on screen; that must not erase the position the
  // reader last chose, so an empty capture is dropped instead of replacing a usable one.
  const captureUserViewportAnchor = useCallback(() => {
    const scroller = activeScrollRefRef.current.current
    const content = contentRef.current
    if (!scroller || !content) return
    const anchor = createUserViewportAnchor(scroller, content)
    recordScrollDiagnostic('anchor-sample', scroller, {
      sampled: anchor !== null,
      anchorIndex: anchor?.anchorIndex ?? null,
      anchorOffset: anchor?.offsetFromScrollerTop ?? null,
    })
    if (!anchor) return
    selfScrollOffsetRef.current = 0
    userViewportAnchorRef.current = anchor
    startConversationFrameProbe(scroller, readProbeState)
  }, [activeScrollRefRef, contentRef, readProbeState, selfScrollOffsetRef, userViewportAnchorRef])

  // With overflow-anchor:none, Chromium preserves scrollTop across content and viewport resizing.
  // Only our own writes and the native range clamp must be excluded from the reader's movement.
  const readReaderScrollOffsetSinceAnchor = useCallback(
    (scroller: HTMLElement, maximumOffset: number): number => {
      const anchor = userViewportAnchorRef.current
      if (!anchor) return scroller.scrollTop
      const believedScrollTop = anchor.scrollTopPx + selfScrollOffsetRef.current
      // A shrinking layout also removes offsets the sample used to have: the clamp is the layout's
      // own doing exactly like the height change, so the belief is moved with it rather than counted
      // as the reader's scrolling, which would make the next correction ask for an offset that does
      // not exist.
      const clampedScrollTop = bottomOrigin
        ? Math.min(0, Math.max(-maximumOffset, believedScrollTop))
        : Math.min(maximumOffset, Math.max(0, believedScrollTop))
      selfScrollOffsetRef.current += clampedScrollTop - believedScrollTop
      return scroller.scrollTop - clampedScrollTop
    },
    [bottomOrigin, selfScrollOffsetRef, userViewportAnchorRef]
  )

  // With native anchoring disabled, correction = ΔanchorOffset + ΔreaderScrollTop.
  // Pure reader motion cancels out because moving scrollTop by x moves text by -x
  // in either origin. The remainder is the layout shift to return to the reader.
  const restoreReaderPositionFromLayout = useCallback(() => {
    const scroller = activeScrollRefRef.current.current
    const content = contentRef.current
    const anchor = userViewportAnchorRef.current
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
    const anchorRect =
      anchor.textOffset === null
        ? anchorElement.getBoundingClientRect()
        : (getTextOffsetRect(anchorElement, anchor.textOffset) ??
          anchorElement.getBoundingClientRect())

    const anchorOffset = anchorRect.top - scroller.getBoundingClientRect().top
    const readerScrollTop = readReaderScrollOffsetSinceAnchor(
      scroller,
      getMaximumScrollOffset(scroller)
    )
    const correction = anchorOffset - anchor.offsetFromScrollerTop + readerScrollTop
    const layout = `${Math.round(getMaximumScrollOffset(scroller))}:${scroller.clientWidth}:${scroller.clientHeight}`
    // A layout this rule has not measured yet counts as still moving: the first frame of a re-layout is
    // exactly the one that used to hand the reader a position taken in the middle of it.
    const layoutChanged = lastMeasuredLayoutRef.current !== layout
    lastMeasuredLayoutRef.current = layout
    if (Math.abs(correction) < 1) {
      recordScrollDiagnostic('anchor-correction', scroller, {
        ...getConversationDiagnosticContext(anchorElement),
        anchorOffset,
        previousAnchorOffset: anchor.offsetFromScrollerTop,
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
    scroller.scrollTop = previousScrollTop + correction
    const appliedScrollTop = scroller.scrollTop - previousScrollTop
    recordScrollDiagnostic('anchor-correction', scroller, {
      ...getConversationDiagnosticContext(anchorElement),
      anchorOffset,
      previousAnchorOffset: anchor.offsetFromScrollerTop,
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
    selfScrollOffsetRef.current += appliedScrollTop
    lastScrollPositionRef.current = getDistanceFromTop(scroller, bottomOrigin)
    if (Math.abs(appliedScrollTop - correction) < 1 && !layoutChanged) {
      // The reader is settled again where this sample was taken, so the next layout change has to
      // measure from here rather than from a baseline that already includes this correction.
      captureUserViewportAnchor()
    }
  }, [
    activeScrollRefRef,
    bottomOrigin,
    captureUserViewportAnchor,
    contentRef,
    lastMeasuredLayoutRef,
    lastScrollPositionRef,
    readReaderScrollOffsetSinceAnchor,
    selfScrollOffsetRef,
    userViewportAnchorRef,
  ])

  return { captureUserViewportAnchor, restoreReaderPositionFromLayout }
}
