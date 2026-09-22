import { ArrowDown } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect } from 'react'

import { useConversationTranslation } from './ConversationTranslation'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

import { MessageList } from './MessageList'
import { ReaderDisclosureProvider } from './ReaderDisclosure'
import { MessageTurnNavigation } from './MessageTurnNavigation'

import {
  getConversationScrollSnapshot,
  hasConversationScrollSnapshot,
} from './conversationViewportCache'
import { getDistanceFromBottom, getDistanceFromTop } from './bottomOriginScroll'

import {
  SCROLLED_TO_BOTTOM_THRESHOLD,
  type ScrollableMessageAreaProps,
  areScrollableMessageAreaPropsEqual,
} from './scrollableMessageTypes'
import {
  getInitialDistanceFromBottomPx,
  getMaximumScrollOffset,
  createUserViewportAnchor,
  findUserViewportAnchor,
  getTextOffsetRect,
  findLatestUserMessageId,
} from './conversationScrollGeometry'
import { useConversationScrollController } from './useConversationScrollController'
export const ScrollableMessageArea = memo(function ScrollableMessageArea(
  props: ScrollableMessageAreaProps
) {
  return <ScrollableMessagePaneContent {...props} />
}, areScrollableMessageAreaPropsEqual)

function ScrollableMessagePaneContent({
  userMessageServices,
  virtualize = true,
  useContentVisibility,
  onVirtualMeasurement,
  renderVisualization,
  messages,
  turns,
  loading = false,
  isWaitingForAssistant = false,
  hasMoreBefore = false,
  loadingMoreBefore = false,
  turnNavigation,
  loadedTranscriptRanges,
  className,
  scrollerClassName,
  contentClassName,
  messageListClassName,
  contentFooter,
  contentFooterClassName,
  stickyFooter,
  stickyFooterClassName,
  scrollButtonClassName,
  scrollTestId = 'chat-message-scroll-area',
  externalScrollRef,
  externalScrollInteractionRef,
  turnNavigationPortalTarget,
  conversationKey,
  devices,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  fileChangesDiffPreviewDisabledSubtaskId,
  onOpenWorkspaceFile,
  onOpenLocalSkillFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  onOpenSubagent,
  onEditLastUserMessage,
  canEditLastUserMessage,
  onForkMessage,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  onAddSelectionToConversation,
  onAskSelectionInSidebar,
  autoScrollSuspended = false,
  onLoadMoreBefore,
  onLoadTurnNavigationItem,
  onLoadTranscriptGap,
  initialScrollPosition = 'restore',
  scrollOrigin = 'top',
}: ScrollableMessageAreaProps) {
  const { t, translate } = useConversationTranslation()
  const {
    explicitBottomFollowRef,
    selfScrollOffsetRef,
    lastMeasuredLayoutRef,
    clearUserViewportAnchor,
    scheduleBottomFollowRelease,
    internalScrollRef,
    scrollRef,
    bottomOrigin,
    activeScrollRefRef,
    contentRef,
    stickyFooterRef,
    isAtBottomRef,
    turnNavigationScrollingRef,
    turnNavigationScrollKeyRef,
    previousConversationKeyRef,
    previousLastMessageIdRef,
    pendingAssistantResponseStartRef,
    previousLatestUserMessageIdRef,
    previousLatestGuidanceMessageIdRef,
    previousMessageCountRef,
    previousLoadingRef,
    previousWaitingForAssistantRef,
    hasRenderedRef,
    streamingFollowOwnedRef,
    restoredScrollSnapshotRef,
    virtualInitialPositionOwnerRef,
    followingBottomKeyRef,
    preserveLatestUserTurnRef,
    userScrollPausedAutoFollowRef,
    userScrollIntentRef,
    userViewportAnchorRef,
    lastScrollPositionRef,
    scheduledScrollStateSignatureRef,
    completedScrollStateSignatureRef,
    pendingLayoutScrollPositionRef,
    showScrollButton,
    setShowScrollButton,
    turnNavigationLoading,
    turnNavigationTargetMessageId,
    lastMessage,
    streamingFollowActive,
    latestGuidanceMessageId,
    currentScrollKey,
    virtualScrollOwnsInitialPosition,
    messageScrollSignature,
    scrollStateFrameSignature,
    clearScheduledScrolls,
    isTurnNavigationAutoScrollSuspended,
    releasePendingLayoutScrollPosition,
    preserveScrollPositionForNextLayout,
    preserveReaderPositionForDisclosure,
    handleTurnNavigationScrollTargetChange,
    handleTurnNavigationLoadStateChange,
    renderTranscriptGapAfterMessage,
    updateScrollState,
    restorePendingLayoutScrollPosition,
    setScrollToBottom,
    restoreSavedScrollPosition,
    scrollToBottom,
    followStreamingToBottom,
    adoptVirtualBottomPosition,
    scheduleStableScrollToBottom,
  } = useConversationScrollController({
    messages,
    externalScrollRef,
    scrollOrigin,
    loading,
    isWaitingForAssistant,
    conversationKey,
    virtualize,
    onLoadTranscriptGap,
    loadedTranscriptRanges,
    autoScrollSuspended,
  })
  useLayoutEffect(() => {
    const isInitialRender = !hasRenderedRef.current
    const conversationChanged = previousConversationKeyRef.current !== conversationKey
    const messagesLoaded = previousMessageCountRef.current === 0 && messages.length > 0
    const lastMessageChanged = previousLastMessageIdRef.current !== (lastMessage?.id ?? null)
    const latestUserMessageId = findLatestUserMessageId(messages)
    const firstUserMessageAppended =
      !isInitialRender &&
      !conversationChanged &&
      !loading &&
      !previousLoadingRef.current &&
      previousMessageCountRef.current === 0 &&
      lastMessage?.role === 'user' &&
      latestUserMessageId !== null
    const latestUserMessageChanged =
      !conversationChanged &&
      ((previousMessageCountRef.current > 0 &&
        previousLatestUserMessageIdRef.current !== null &&
        latestUserMessageId !== null &&
        previousLatestUserMessageIdRef.current !== latestUserMessageId) ||
        firstUserMessageAppended)
    const guidanceMessageApplied =
      !conversationChanged &&
      previousMessageCountRef.current > 0 &&
      lastMessageChanged &&
      latestGuidanceMessageId !== null &&
      previousLatestGuidanceMessageIdRef.current !== latestGuidanceMessageId
    const waitingForAssistantStarted =
      !conversationChanged && !previousWaitingForAssistantRef.current && isWaitingForAssistant
    const assistantResponseStarted =
      !conversationChanged &&
      lastMessageChanged &&
      lastMessage?.role === 'assistant' &&
      !userScrollPausedAutoFollowRef.current
    if (conversationChanged) {
      turnNavigationScrollingRef.current = false
      turnNavigationScrollKeyRef.current = null
    }
    const autoScrollIsSuspended = autoScrollSuspended || isTurnNavigationAutoScrollSuspended()
    if (conversationChanged) {
      pendingAssistantResponseStartRef.current = false
    }
    if (assistantResponseStarted && autoScrollIsSuspended) {
      pendingAssistantResponseStartRef.current = true
    }
    const pendingAssistantResponseStarted =
      pendingAssistantResponseStartRef.current && !autoScrollIsSuspended
    // Anything the reader did themselves (sending a message, applying guidance) still has to bring the
    // newest content into view.
    const readerActionBringsNewestIntoView =
      guidanceMessageApplied ||
      latestUserMessageChanged ||
      (lastMessageChanged && lastMessage?.role === 'user')
    // The assistant's turn starting is not the reader's action, so it may only take the viewport while
    // the reader has not parked in the history above it. `assistantResponseStarted` already carried that
    // gate; `waitingForAssistantStarted` did not, and a parked reader was dragged to the bottom the
    // moment their queued turn began answering.
    const assistantTurnStarted =
      waitingForAssistantStarted || assistantResponseStarted || pendingAssistantResponseStarted
    // While the reader is parked in the history of the conversation they are already in, a
    // transcript (re)load must not restore the snapshot taken before they scrolled up: that
    // stale distance can be pinned to the bottom and yank the viewport back down.
    const readerOwnsViewport =
      !conversationChanged &&
      userScrollPausedAutoFollowRef.current &&
      !readerActionBringsNewestIntoView
    const shouldRestoreScroll = Boolean(
      initialScrollPosition === 'restore' &&
      currentScrollKey &&
      messages.length > 0 &&
      (conversationChanged || messagesLoaded) &&
      hasConversationScrollSnapshot(currentScrollKey) &&
      !readerOwnsViewport
    )
    const shouldForceBottom =
      !shouldRestoreScroll &&
      !readerOwnsViewport &&
      (conversationChanged ||
        messagesLoaded ||
        readerActionBringsNewestIntoView ||
        (assistantTurnStarted && !userScrollPausedAutoFollowRef.current))

    previousConversationKeyRef.current = conversationKey
    previousLastMessageIdRef.current = lastMessage?.id ?? null
    previousLatestUserMessageIdRef.current = latestUserMessageId
    previousLatestGuidanceMessageIdRef.current = latestGuidanceMessageId
    previousMessageCountRef.current = messages.length
    previousLoadingRef.current = loading
    previousWaitingForAssistantRef.current = isWaitingForAssistant
    hasRenderedRef.current = true

    if (conversationChanged) {
      clearUserViewportAnchor()
      restoredScrollSnapshotRef.current = null
      virtualInitialPositionOwnerRef.current = null
      preserveLatestUserTurnRef.current = false
      explicitBottomFollowRef.current = false
      releasePendingLayoutScrollPosition()
    } else if (latestUserMessageChanged) {
      preserveLatestUserTurnRef.current = true
    }

    if (virtualInitialPositionOwnerRef.current?.key === currentScrollKey) {
      clearScheduledScrolls()
      return
    }

    if (messages.length === 0) {
      return
    }

    if (autoScrollIsSuspended) {
      clearScheduledScrolls()
      return
    }

    if (shouldRestoreScroll && currentScrollKey) {
      clearScheduledScrolls()
      const snapshot = getConversationScrollSnapshot(currentScrollKey)
      if (snapshot) {
        restoredScrollSnapshotRef.current = { key: currentScrollKey, snapshot }
        if (virtualScrollOwnsInitialPosition && snapshot.pinnedToBottom) {
          adoptVirtualBottomPosition()
          return
        }
        restoreSavedScrollPosition(currentScrollKey, snapshot)
      }
      return
    }

    if (shouldForceBottom) {
      restoredScrollSnapshotRef.current = null
      pendingAssistantResponseStartRef.current = false
      userScrollPausedAutoFollowRef.current = false
      clearUserViewportAnchor()
      if (virtualScrollOwnsInitialPosition && (conversationChanged || messagesLoaded)) {
        adoptVirtualBottomPosition()
        return
      }
      if (streamingFollowActive) {
        preserveLatestUserTurnRef.current = false
        followStreamingToBottom()
        return
      }
      setScrollToBottom('auto', { saveSnapshot: false })
      if (preserveLatestUserTurnRef.current) {
        scheduleStableScrollToBottom('auto', {
          saveSnapshot: false,
          releaseAfterStable: true,
        })
        return
      }
      scheduleStableScrollToBottom('auto', { saveSnapshot: false })
      return
    }

    if (preserveLatestUserTurnRef.current) {
      if (followingBottomKeyRef.current !== currentScrollKey) {
        clearScheduledScrolls()
      }
      return
    }

    if (isAtBottomRef.current && !userScrollPausedAutoFollowRef.current) {
      if (streamingFollowActive) {
        followStreamingToBottom()
        return
      }
      const shouldStabilizeExternalBottom =
        externalScrollRef?.current &&
        currentScrollKey !== null &&
        getConversationScrollSnapshot(currentScrollKey)?.pinnedToBottom === true
      if (shouldStabilizeExternalBottom) {
        scheduleStableScrollToBottom('auto', { saveSnapshot: false })
      } else {
        scrollToBottom('auto', { saveSnapshot: false })
      }
    }
  }, [
    conversationKey,
    adoptVirtualBottomPosition,
    autoScrollSuspended,
    currentScrollKey,
    clearScheduledScrolls,
    clearUserViewportAnchor,
    externalScrollRef,
    followStreamingToBottom,
    isTurnNavigationAutoScrollSuspended,
    isWaitingForAssistant,
    lastMessage,
    latestGuidanceMessageId,
    initialScrollPosition,
    loading,
    messageScrollSignature,
    messages,
    messages.length,
    releasePendingLayoutScrollPosition,
    restoreSavedScrollPosition,
    scheduleStableScrollToBottom,
    scrollToBottom,
    setScrollToBottom,
    streamingFollowActive,
    virtualScrollOwnsInitialPosition,
  ])

  useLayoutEffect(() => {
    const turnNavigationSettled = !turnNavigationLoading && turnNavigationTargetMessageId === null
    if (
      !pendingAssistantResponseStartRef.current ||
      messages.length === 0 ||
      autoScrollSuspended ||
      !turnNavigationSettled ||
      isTurnNavigationAutoScrollSuspended()
    ) {
      return
    }

    pendingAssistantResponseStartRef.current = false
    // The reader may have taken the viewport over while the response start was held back; a turn that
    // begins answering never gets to take it away from them.
    if (userScrollPausedAutoFollowRef.current) return
    if (streamingFollowActive) {
      followStreamingToBottom()
    } else {
      setScrollToBottom('auto', { saveSnapshot: false })
      scheduleStableScrollToBottom('auto', { saveSnapshot: false })
    }
  }, [
    autoScrollSuspended,
    followStreamingToBottom,
    isTurnNavigationAutoScrollSuspended,
    messages.length,
    scheduleStableScrollToBottom,
    setScrollToBottom,
    streamingFollowActive,
    turnNavigationLoading,
    turnNavigationTargetMessageId,
  ])

  useLayoutEffect(() => {
    if (
      completedScrollStateSignatureRef.current === scrollStateFrameSignature ||
      scheduledScrollStateSignatureRef.current === scrollStateFrameSignature
    ) {
      return
    }

    scheduledScrollStateSignatureRef.current = scrollStateFrameSignature
    const frame = requestAnimationFrame(() => {
      if (scheduledScrollStateSignatureRef.current !== scrollStateFrameSignature) return
      scheduledScrollStateSignatureRef.current = null
      completedScrollStateSignatureRef.current = scrollStateFrameSignature
      updateScrollState({ skipSave: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      if (scheduledScrollStateSignatureRef.current === scrollStateFrameSignature) {
        scheduledScrollStateSignatureRef.current = null
      }
    }
  }, [scrollStateFrameSignature, updateScrollState])

  // Records where the reader is looking, together with the scroll offset that position belongs to.
  // A transient layout state can leave nothing on screen; that must not erase the position the
  // reader last chose, so an empty capture is dropped instead of replacing a usable one.
  const captureUserViewportAnchor = useCallback(() => {
    const scroller = activeScrollRefRef.current.current
    const content = contentRef.current
    if (!scroller || !content) return
    const anchor = createUserViewportAnchor(scroller, content)
    if (!anchor) return
    selfScrollOffsetRef.current = 0
    userViewportAnchorRef.current = anchor
  }, [])

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
    [bottomOrigin]
  )

  /**
   * Puts the text the reader is looking at back where it belongs after a layout change.
   *
   * The browser's own scroll anchoring is switched off for this scroller (`[overflow-anchor:none]`),
   * so the only things that can move the reader are their own scrolling and the layout change that
   * just happened. That makes the correction measurable without assuming anything about how the
   * browser reacts to content height changes:
   *
   *   correction = ΔanchorOffset + ΔreaderScrollTop
   *
   * `ΔanchorOffset` is how far the sampled text moved on screen; the second term is how far the reader
   * scrolled, as read back by `readReaderScrollOffsetSinceAnchor`. A pure reader scroll moves the text
   * by exactly the negative of their scrolling, so it cancels to zero and their scrolling is never
   * taken back; whatever is left is the layout change's own effect, and writing it back is what keeps
   * a reflow, a re-measured row above the viewport, and a streaming response growing underneath from
   * dragging the text away — all cases the browser used to handle for us with a rule that turned out
   * to depend on where the content changed.
   *
   * Both signs work out because moving `scrollTop` by `x` moves the text by `-x` in every scroll
   * origin the chat list is rendered with.
   */
  const restoreReaderPositionFromLayout = useCallback(() => {
    const scroller = activeScrollRefRef.current.current
    const content = contentRef.current
    const anchor = userViewportAnchorRef.current
    if (!scroller || !content || !anchor) {
      return
    }

    const anchorElement = findUserViewportAnchor(content, anchor)
    if (!anchorElement) {
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
  }, [bottomOrigin, captureUserViewportAnchor, readReaderScrollOffsetSinceAnchor])

  /**
   * Puts the text back where the reader left it whenever the offset has moved since the sample for a
   * reason of the layout's own, and leaves everything alone while another part of the scroll owner is
   * already moving the viewport.
   *
   * Run before sampling new input: a re-measured row can move the visible text even when scrollTop
   * stays fixed. Sampling that displaced text would otherwise leave the layout shift uncorrected.
   */
  const restoreReaderPositionIfOwned = useCallback(() => {
    if (!userScrollPausedAutoFollowRef.current) return
    if (pendingLayoutScrollPositionRef.current !== null) return
    if (preserveLatestUserTurnRef.current) return
    if (restoredScrollSnapshotRef.current?.key === currentScrollKey) return
    restoreReaderPositionFromLayout()
  }, [currentScrollKey, restoreReaderPositionFromLayout])

  const handleContentLayoutChange = useCallback(() => {
    if (virtualInitialPositionOwnerRef.current?.key === currentScrollKey) {
      virtualInitialPositionOwnerRef.current = null
      return
    }
    if (restorePendingLayoutScrollPosition()) {
      return
    }
    if (autoScrollSuspended || isTurnNavigationAutoScrollSuspended()) {
      return
    }

    if (preserveLatestUserTurnRef.current) {
      return
    }

    const restoredSnapshot = restoredScrollSnapshotRef.current
    if (restoredSnapshot?.key === currentScrollKey) {
      restoreSavedScrollPosition(restoredSnapshot.key, restoredSnapshot.snapshot)
      return
    }

    if (userScrollPausedAutoFollowRef.current) {
      // The reader owns the viewport, so measure what this layout did to the row they were reading
      // and put it back. Measuring the DOM after the layout lands keeps the text still without
      // predicting how far a re-measured row moved it.
      restoreReaderPositionFromLayout()
      return
    }

    const shouldFollowBottom =
      followingBottomKeyRef.current === currentScrollKey ||
      (currentScrollKey !== null &&
        getConversationScrollSnapshot(currentScrollKey)?.pinnedToBottom === true)
    if (shouldFollowBottom) {
      if (streamingFollowActive && !explicitBottomFollowRef.current) {
        followStreamingToBottom()
      } else {
        setScrollToBottom('auto', { saveSnapshot: false })
      }
      if (explicitBottomFollowRef.current) {
        // The reader asked to jump to the bottom and the ownership is still held, so this layout change
        // restarts the release window: a follow that outlasted one budget stays owned until the growth
        // stops, and is handed back afterwards instead of pinning the viewport forever.
        scheduleBottomFollowRelease()
      }
      return
    }

    if (isAtBottomRef.current) {
      if (streamingFollowActive) {
        followStreamingToBottom()
      } else {
        scrollToBottom('auto', { saveSnapshot: false })
      }
    }
  }, [
    autoScrollSuspended,
    currentScrollKey,
    followStreamingToBottom,
    isTurnNavigationAutoScrollSuspended,
    restoreSavedScrollPosition,
    restorePendingLayoutScrollPosition,
    restoreReaderPositionFromLayout,
    scheduleBottomFollowRelease,
    scrollToBottom,
    setScrollToBottom,
    streamingFollowActive,
  ])

  useEffect(() => {
    const content = contentRef.current
    const footer = stickyFooterRef.current
    const scroller = activeScrollRefRef.current.current
    if (!content || !scroller || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      handleContentLayoutChange()
    })

    resizeObserver.observe(scroller)
    resizeObserver.observe(content)
    if (footer) {
      resizeObserver.observe(footer)
    }
    return () => resizeObserver.disconnect()
  }, [bottomOrigin, handleContentLayoutChange, stickyFooter])

  useEffect(
    () => () => {
      clearScheduledScrolls()
      releasePendingLayoutScrollPosition()
    },
    [clearScheduledScrolls, releasePendingLayoutScrollPosition]
  )

  const handleScrollToBottom = () => {
    userScrollIntentRef.current = false
    userScrollPausedAutoFollowRef.current = false
    clearUserViewportAnchor()
    preserveLatestUserTurnRef.current = false
    explicitBottomFollowRef.current = true
    scheduleStableScrollToBottom('smooth', {
      saveSnapshot: true,
      releaseAfterStable: true,
    })
  }

  const markUserScrollIntent = useCallback(
    (event?: Event | { nativeEvent?: Event }) => {
      if (pendingLayoutScrollPositionRef.current?.distanceFromTopPx !== undefined) {
        releasePendingLayoutScrollPosition()
      }
      userScrollIntentRef.current = true
      restoredScrollSnapshotRef.current = null

      const nativeEvent = event && 'nativeEvent' in event ? event.nativeEvent : event
      if (nativeEvent && 'deltaY' in nativeEvent && Number(nativeEvent.deltaY) < 0) {
        clearScheduledScrolls()
        explicitBottomFollowRef.current = false
        userScrollPausedAutoFollowRef.current = true
      }
      // The reader's position, sampled from their own input and before that input moves the viewport. Only
      // input may take a position as theirs: a panel opening beside the conversation moves the offset too,
      // and that movement has to stay with the layout so a correction can give it back. Whatever layout
      // was still moving is put right first, so the reader is not handed a position taken mid-reflow.
      restoreReaderPositionIfOwned()
      captureUserViewportAnchor()
    },
    [
      captureUserViewportAnchor,
      clearScheduledScrolls,
      releasePendingLayoutScrollPosition,
      restoreReaderPositionIfOwned,
    ]
  )

  const handleScroll = useCallback(() => {
    if (pendingLayoutScrollPositionRef.current?.distanceFromTopPx !== undefined) return
    if (autoScrollSuspended || isTurnNavigationAutoScrollSuspended()) {
      return
    }

    const userInitiated = userScrollIntentRef.current
    userScrollIntentRef.current = false
    if (userInitiated) {
      preserveLatestUserTurnRef.current = false
      const pending = pendingLayoutScrollPositionRef.current
      const scroller = activeScrollRefRef.current.current
      if (pending && scroller && pending.conversationKey === currentScrollKey) {
        pending.scrollHeightPx = scroller.scrollHeight
        pending.distanceFromBottomPx = getDistanceFromBottom(scroller, bottomOrigin)
      }
    }
    // Run before the scroll state is read below: a layout clamp that reached the end of the history
    // would otherwise look like the reader arriving back at the bottom and release their pause.
    restoreReaderPositionIfOwned()
    if (!userInitiated) {
      if (streamingFollowOwnedRef.current) {
        setShowScrollButton(false)
        return
      }
      const shouldFollowBottom =
        (currentScrollKey !== null && followingBottomKeyRef.current === currentScrollKey) ||
        (currentScrollKey !== null &&
          getConversationScrollSnapshot(currentScrollKey)?.pinnedToBottom === true)
      const scroller = activeScrollRefRef.current.current
      const distanceFromBottom =
        scroller === null ? Number.POSITIVE_INFINITY : getDistanceFromBottom(scroller, bottomOrigin)
      if (shouldFollowBottom && distanceFromBottom > SCROLLED_TO_BOTTOM_THRESHOLD) {
        if (streamingFollowActive && !explicitBottomFollowRef.current) {
          followStreamingToBottom()
        } else {
          setScrollToBottom('auto', { saveSnapshot: false })
        }
        return
      }
      updateScrollState({ skipSave: true })
      return
    }
    updateScrollState({ forceSave: true })
    // No sample is taken here: the reader's input already took one before it moved the viewport, and an
    // offset that moved for the layout's own reasons must not be adopted as a position of theirs.
  }, [
    autoScrollSuspended,
    bottomOrigin,
    currentScrollKey,
    followStreamingToBottom,
    isTurnNavigationAutoScrollSuspended,
    restoreReaderPositionIfOwned,
    setScrollToBottom,
    streamingFollowActive,
    updateScrollState,
  ])

  useEffect(() => {
    const externalScroller = externalScrollRef?.current
    if (!externalScroller || externalScroller === internalScrollRef.current) return
    const externalInteraction = externalScrollInteractionRef?.current
    const interactionTargets = externalInteraction
      ? [externalScroller, externalInteraction]
      : [externalScroller]
    const markScrollbarDrag = (event: PointerEvent) => {
      if (event.buttons === 1) markUserScrollIntent(event)
    }

    externalInteraction?.addEventListener('pointermove', markScrollbarDrag)
    externalScroller.addEventListener('scroll', handleScroll)
    interactionTargets.forEach(target => {
      target.addEventListener('wheel', markUserScrollIntent)
      target.addEventListener('pointerdown', markUserScrollIntent)
      target.addEventListener('touchstart', markUserScrollIntent)
      target.addEventListener('keydown', markUserScrollIntent)
    })
    return () => {
      externalInteraction?.removeEventListener('pointermove', markScrollbarDrag)
      externalScroller.removeEventListener('scroll', handleScroll)
      interactionTargets.forEach(target => {
        target.removeEventListener('wheel', markUserScrollIntent)
        target.removeEventListener('pointerdown', markUserScrollIntent)
        target.removeEventListener('touchstart', markUserScrollIntent)
        target.removeEventListener('keydown', markUserScrollIntent)
      })
    }
  }, [externalScrollInteractionRef, externalScrollRef, handleScroll, markUserScrollIntent])

  const scrollToBottomButton = showScrollButton ? (
    <button
      type="button"
      data-testid="scroll-to-bottom-button"
      onClick={handleScrollToBottom}
      className={cn(
        'absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-text-primary shadow-sm hover:bg-muted',
        scrollButtonClassName
      )}
      aria-label={t('workbench.scroll_to_bottom')}
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  ) : null

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      {turnNavigationLoading && (
        <div
          className="pointer-events-none absolute left-1/2 top-5 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-text-secondary shadow-[0_8px_22px_rgba(15,23,42,0.12)]"
          data-testid="message-turn-navigation-loading"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary opacity-80" />
          <span>{t('message_navigation.loading_target')}</span>
        </div>
      )}
      <div
        ref={internalScrollRef}
        data-testid={scrollTestId}
        data-scroll-origin={bottomOrigin ? 'bottom' : 'top'}
        className={cn(
          'h-full overflow-y-auto [overflow-anchor:none]',
          Boolean(stickyFooter) && 'flex flex-col',
          bottomOrigin &&
            externalScrollRef === undefined &&
            'flex flex-col-reverse [overflow-anchor:none]',
          scrollerClassName
        )}
        onScroll={handleScroll}
        onWheel={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
        onKeyDown={markUserScrollIntent}
      >
        <div
          ref={contentRef}
          data-testid={`${scrollTestId}-content`}
          className={cn(
            'min-w-0 [overflow-anchor:none]',
            Boolean(stickyFooter) && 'flex-1 shrink-0',
            contentClassName
          )}
        >
          {messages.length === 0 ? (
            loading ? (
              <div
                data-testid="chat-loading-state"
                className="flex min-h-full items-center justify-center px-6 py-16 text-center text-sm text-text-muted"
              >
                {t('workbench.loading_conversation')}
              </div>
            ) : (
              <div
                data-testid="chat-empty-state"
                className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center"
              >
                <h2 className="text-sm font-medium text-text-primary">
                  {t('workbench.empty_conversation_title')}
                </h2>
                <p className="mt-2 max-w-sm text-xs leading-5 text-text-muted">
                  {t('workbench.empty_conversation_description')}
                </p>
              </div>
            )
          ) : (
            <>
              {hasMoreBefore && (
                <div className="flex justify-center px-4 pb-2 pt-4">
                  <button
                    type="button"
                    data-testid="load-older-runtime-transcript-button"
                    onClick={() => {
                      preserveScrollPositionForNextLayout()
                      void onLoadMoreBefore?.()
                    }}
                    disabled={loadingMoreBefore || !onLoadMoreBefore}
                    className="flex h-11 min-w-[44px] items-center justify-center rounded-md border border-border bg-surface px-4 text-xs font-medium text-text-secondary hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                  >
                    {loadingMoreBefore
                      ? t('workbench.loading_older_messages')
                      : t('workbench.load_older_messages')}
                  </button>
                </div>
              )}
              <ReaderDisclosureProvider
                onReaderDisclosure={preserveReaderPositionForDisclosure}
              >
                <MessageList
                  userMessageServices={userMessageServices}
                  virtualize={virtualize}
                  useContentVisibility={useContentVisibility}
                  onVirtualMeasurement={onVirtualMeasurement}
                  renderVisualization={renderVisualization}
                  key={currentScrollKey ?? 'keyless-conversation'}
                  messages={messages}
                  turns={turns}
                  onVirtualLayoutChange={handleContentLayoutChange}
                  scrollElementRef={scrollRef}
                  initialDistanceFromBottomPx={getInitialDistanceFromBottomPx(currentScrollKey)}
                  className={messageListClassName}
                  conversationKey={conversationKey}
                  forceVirtualMessageId={turnNavigationTargetMessageId}
                  isWaitingForAssistant={isWaitingForAssistant}
                  disableContentVisibility={turnNavigationLoading}
                  devices={devices}
                  onRetryFailedMessage={onRetryFailedMessage}
                  onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
                  onLoadFileChangesDiff={onLoadFileChangesDiff}
                  onRevertFileChanges={onRevertFileChanges}
                  onOpenFileChangesReview={onOpenFileChangesReview}
                  fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
                  onOpenWorkspaceFile={onOpenWorkspaceFile}
                  onOpenLocalSkillFile={onOpenLocalSkillFile}
                  onRequestUserInputSubmit={onRequestUserInputSubmit}
                  onRequestUserInputIgnore={onRequestUserInputIgnore}
                  onOpenAssistantPlan={onOpenAssistantPlan}
                  onOpenSubagent={onOpenSubagent}
                  onEditLastUserMessage={onEditLastUserMessage}
                  canEditLastUserMessage={canEditLastUserMessage}
                  onForkMessage={onForkMessage}
                  hideRequestUserInputBlocks={hideRequestUserInputBlocks}
                  hiddenRequestUserInputIds={hiddenRequestUserInputIds}
                  onAddSelectionToConversation={onAddSelectionToConversation}
                  onAskSelectionInSidebar={onAskSelectionInSidebar}
                  virtualAnchorToEnd={!showScrollButton}
                  bottomOrigin={bottomOrigin}
                  renderGapAfterMessage={renderTranscriptGapAfterMessage}
                />
              </ReaderDisclosureProvider>
              {contentFooter ? (
                <div
                  data-testid={`${scrollTestId}-content-footer`}
                  className={contentFooterClassName}
                >
                  {contentFooter}
                </div>
              ) : null}
            </>
          )}
        </div>
        {stickyFooter ? (
          <div
            ref={stickyFooterRef}
            data-testid={`${scrollTestId}-sticky-footer`}
            className={cn('sticky bottom-0 z-10 w-full shrink-0', stickyFooterClassName)}
          >
            <div className="relative h-0">{scrollToBottomButton}</div>
            {stickyFooter}
          </div>
        ) : null}
      </div>
      <MessageTurnNavigation
        translate={translate}
        messages={messages}
        turnNavigation={turnNavigation}
        scrollRef={scrollRef}
        contentRef={contentRef}
        onLoadTurnNavigationItem={onLoadTurnNavigationItem}
        onNavigationLoadStateChange={handleTurnNavigationLoadStateChange}
        onNavigationScrollTargetChange={handleTurnNavigationScrollTargetChange}
        portalTarget={turnNavigationPortalTarget}
      />
      {!stickyFooter ? scrollToBottomButton : null}
    </div>
  )
}
