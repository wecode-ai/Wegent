import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'

import { computeStreamingScrollStep, STREAM_FOLLOW_SETTLE_PX } from './streamingScrollFollow'
import {
  cancelSafeAnimationFrame,
  requestSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from '../markdown/safeAnimationFrame'
import {
  getConversationScrollSnapshot,
  type ConversationScrollSnapshot,
} from './conversationViewportCache'
import {
  getDistanceFromBottom,
  getDistanceFromTop,
  setDistanceFromBottom,
} from './bottomOriginScroll'

import {
  BOTTOM_THRESHOLD,
  SCROLLED_TO_BOTTOM_THRESHOLD,
  STABLE_SCROLL_DELAYS,
  STABLE_SCROLL_RELEASE_RETRIES,
  type RuntimeTranscriptGap,
  type UserViewportAnchor,
  type PendingLayoutScrollPosition,
  type ScrollableMessageAreaProps,
} from './scrollableMessageTypes'
import {
  scrollPositionKey,
  findLatestGuidanceMessageId,
  setConversationScrollSnapshot,
  createScrollSnapshot,
} from './conversationScrollGeometry'
import {
  RuntimeTranscriptGapMarker,
  runtimeTranscriptGapBetween,
  runtimeTranscriptGapKey,
} from './RuntimeTranscriptGapMarker'
export function useConversationScrollController({
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
}: Pick<
  ScrollableMessageAreaProps,
  | 'messages'
  | 'externalScrollRef'
  | 'scrollOrigin'
  | 'loading'
  | 'isWaitingForAssistant'
  | 'conversationKey'
  | 'virtualize'
  | 'onLoadTranscriptGap'
  | 'loadedTranscriptRanges'
  | 'autoScrollSuspended'
>) {
  const internalScrollRef = useRef<HTMLDivElement>(null)
  const scrollRef = externalScrollRef ?? internalScrollRef
  const bottomOrigin = externalScrollRef !== undefined || scrollOrigin === 'bottom'
  const activeScrollRefRef = useRef(scrollRef)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyFooterRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const turnNavigationLoadingRef = useRef(false)
  const turnNavigationScrollingRef = useRef(false)
  const turnNavigationScrollKeyRef = useRef<string | null>(null)
  const previousConversationKeyRef = useRef<string | number | null | undefined>(undefined)
  const previousLastMessageIdRef = useRef<string | null>(null)
  const pendingAssistantResponseStartRef = useRef(false)
  const previousLatestUserMessageIdRef = useRef<string | null>(null)
  const previousLatestGuidanceMessageIdRef = useRef<string | null>(null)
  const previousMessageCountRef = useRef(0)
  const previousLoadingRef = useRef(loading)
  const previousWaitingForAssistantRef = useRef(isWaitingForAssistant)
  const hasRenderedRef = useRef(false)
  const scrollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const scrollFrameRef = useRef<number | null>(null)
  const streamingFollowFrameRef = useRef<SafeAnimationFrameHandle | null>(null)
  const streamingFollowLastFrameAtRef = useRef<number | null>(null)
  const streamingFollowVelocityRef = useRef(0)
  const streamingFollowOwnedRef = useRef(false)
  const restoredScrollSnapshotRef = useRef<{
    key: string
    snapshot: ConversationScrollSnapshot
  } | null>(null)
  const virtualInitialPositionOwnerRef = useRef<{ key: string | null } | null>(null)
  const followingBottomKeyRef = useRef<string | null>(null)
  // Set while the user explicitly requested "jump to bottom". During this window the
  // follow engine must snap to the current bottom instead of letting the streaming spring
  // chase a growing viewport, so a concurrently growing response cannot leave the view in
  // the middle of the conversation.
  const explicitBottomFollowRef = useRef(false)
  const bottomFollowReleasePendingRef = useRef(false)
  const preserveLatestUserTurnRef = useRef(false)
  const userScrollPausedAutoFollowRef = useRef(false)
  const userScrollIntentRef = useRef(false)
  const userViewportAnchorRef = useRef<UserViewportAnchor | null>(null)
  // Offset this rule wrote by itself since the anchor was sampled. That write is ours, not the
  // reader's, so the next correction has to leave it out of the reader's scrolling.
  const selfScrollOffsetRef = useRef(0)
  // The layout the last correction measured, so a sample is only replaced while the layout stands still.
  // A pane re-laid out beside the conversation re-wraps its messages over several frames, and replacing
  // the sample between two of them moves the reader onto a layout that is still moving.
  const lastMeasuredLayoutRef = useRef<string | null>(null)
  const clearUserViewportAnchor = useCallback(() => {
    userViewportAnchorRef.current = null
    selfScrollOffsetRef.current = 0
    lastMeasuredLayoutRef.current = null
  }, [])
  const lastScrollPositionRef = useRef<number | null>(null)
  const scheduledScrollStateSignatureRef = useRef<string | null>(null)
  const completedScrollStateSignatureRef = useRef<string | null>(null)
  const loadingTranscriptGapKeyRef = useRef<string | null>(null)
  const autoLoadedTranscriptGapKeysRef = useRef(new Set<string>())
  const pendingLayoutScrollPositionRef = useRef<PendingLayoutScrollPosition | null>(null)
  const lastMeasuredScrollSnapshotRef = useRef<{
    key: string
    snapshot: ConversationScrollSnapshot
  } | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [turnNavigationLoading, setTurnNavigationLoading] = useState(false)
  const [turnNavigationTargetMessageId, setTurnNavigationTargetMessageId] = useState<string | null>(
    null
  )
  const [loadingTranscriptGapKey, setLoadingTranscriptGapKey] = useState<string | null>(null)
  const lastMessage = messages[messages.length - 1]
  const streamingFollowActive =
    lastMessage?.role === 'assistant' && lastMessage.status === 'streaming'
  const latestGuidanceMessageId = findLatestGuidanceMessageId(messages)
  const currentScrollKey = useMemo(() => scrollPositionKey(conversationKey), [conversationKey])
  const virtualScrollOwnsInitialPosition = virtualize
  const messageScrollSignature = useMemo(() => {
    if (!lastMessage) return 'empty'

    const blockSignature = (lastMessage.blocks ?? [])
      .map(block => {
        if (block.type === 'thinking' || block.type === 'text' || block.type === 'plan') {
          return `${block.id}:${block.status}:${block.content.length}`
        }
        if (block.type === 'file_changes') {
          return `${block.id}:${block.status}:${block.fileChanges.file_count}:${block.fileChanges.diff?.length ?? 0}`
        }
        if (block.type === 'subagent') {
          return `${block.id}:${block.status}:${block.agentStatus ?? ''}:${block.output?.length ?? 0}:${block.summary?.length ?? 0}:${block.children?.length ?? 0}`
        }
        return `${block.id}:${block.status}:${String(block.toolOutput ?? '').length}`
      })
      .join('|')

    return [
      messages.length,
      lastMessage.id,
      lastMessage.role,
      lastMessage.status,
      lastMessage.content.length,
      blockSignature,
      isWaitingForAssistant ? 'waiting' : 'idle',
    ].join(':')
  }, [isWaitingForAssistant, lastMessage, messages.length])
  const scrollStateFrameSignature = useMemo(
    () => [currentScrollKey ?? 'none', messageScrollSignature].join(':'),
    [currentScrollKey, messageScrollSignature]
  )

  useLayoutEffect(() => {
    activeScrollRefRef.current = scrollRef
  }, [scrollRef])

  const stopStreamingFollow = useCallback(() => {
    if (streamingFollowFrameRef.current !== null) {
      cancelSafeAnimationFrame(streamingFollowFrameRef.current)
      streamingFollowFrameRef.current = null
    }
    streamingFollowLastFrameAtRef.current = null
    streamingFollowVelocityRef.current = 0
    streamingFollowOwnedRef.current = false
  }, [])

  const clearScheduledScrolls = useCallback(() => {
    scrollTimersRef.current.forEach(timer => clearTimeout(timer))
    scrollTimersRef.current = []
    followingBottomKeyRef.current = null
    bottomFollowReleasePendingRef.current = false
    stopStreamingFollow()

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [stopStreamingFollow])

  const scheduleScrollTimer = useCallback((callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      scrollTimersRef.current = scrollTimersRef.current.filter(current => current !== timer)
      callback()
    }, delay)
    scrollTimersRef.current.push(timer)
  }, [])

  const isTurnNavigationAutoScrollSuspended = useCallback(
    () => turnNavigationLoadingRef.current || turnNavigationScrollingRef.current,
    []
  )

  const releasePendingLayoutScrollPosition = useCallback(() => {
    const pending = pendingLayoutScrollPositionRef.current
    const scroller = activeScrollRefRef.current.current
    if (pending && scroller) {
      scroller.style.overflowAnchor = pending.previousOverflowAnchor
    }
    pendingLayoutScrollPositionRef.current = null
  }, [])

  const preserveScrollPositionForNextLayout = useCallback(() => {
    const scroller = activeScrollRefRef.current.current
    if (!scroller) return

    clearScheduledScrolls()
    releasePendingLayoutScrollPosition()
    pendingLayoutScrollPositionRef.current = {
      conversationKey: currentScrollKey,
      scrollHeightPx: scroller.scrollHeight,
      distanceFromBottomPx: getDistanceFromBottom(scroller, bottomOrigin),
      previousOverflowAnchor: scroller.style.overflowAnchor,
    }
    scroller.style.overflowAnchor = 'none'
  }, [bottomOrigin, clearScheduledScrolls, currentScrollKey, releasePendingLayoutScrollPosition])

  /**
   * Claims the viewport for a disclosure the reader opened or closed themselves.
   *
   * Growing the conversation is not by itself a reason to move the reader, but the content
   * they just revealed is not the content they were reading either: the layout change is
   * theirs, so their place stands and the follow engine hands the viewport back until they
   * return to the bottom.
   */
  const preserveReaderPositionForDisclosure = useCallback(() => {
    preserveScrollPositionForNextLayout()
    const scroller = activeScrollRefRef.current.current
    const pending = pendingLayoutScrollPositionRef.current
    if (!scroller || !pending) return

    pending.distanceFromTopPx = getDistanceFromTop(scroller, bottomOrigin)
    restoredScrollSnapshotRef.current = null
    userScrollIntentRef.current = false
    userScrollPausedAutoFollowRef.current = true
    userViewportAnchorRef.current = null
  }, [bottomOrigin, preserveScrollPositionForNextLayout])

  const handleTurnNavigationScrollTargetChange = useCallback(
    (messageId: string | null) => {
      const scrolling = messageId !== null
      const wasScrolling = turnNavigationScrollingRef.current
      const navigationScrollKey = turnNavigationScrollKeyRef.current
      turnNavigationScrollingRef.current = scrolling
      turnNavigationScrollKeyRef.current = scrolling ? currentScrollKey : null
      setTurnNavigationTargetMessageId(messageId)
      const element = activeScrollRefRef.current.current
      if (
        wasScrolling &&
        !scrolling &&
        element &&
        navigationScrollKey !== null &&
        navigationScrollKey === currentScrollKey
      ) {
        const snapshot = createScrollSnapshot(element, bottomOrigin)
        setConversationScrollSnapshot(currentScrollKey, snapshot)
        followingBottomKeyRef.current = null
        lastScrollPositionRef.current = getDistanceFromTop(element, bottomOrigin)
        isAtBottomRef.current = snapshot.pinnedToBottom
        userScrollPausedAutoFollowRef.current = !snapshot.pinnedToBottom
      }
      if (scrolling) {
        clearScheduledScrolls()
        preserveLatestUserTurnRef.current = false
      }
    },
    [bottomOrigin, clearScheduledScrolls, currentScrollKey]
  )

  const handleTurnNavigationLoadStateChange = useCallback(
    (loading: boolean) => {
      turnNavigationLoadingRef.current = loading
      setTurnNavigationLoading(loading)
      if (loading) {
        clearScheduledScrolls()
        preserveLatestUserTurnRef.current = false
      }
    },
    [clearScheduledScrolls]
  )

  const loadTranscriptGap = useCallback(
    async (gap: RuntimeTranscriptGap, reason: 'visible' | 'click') => {
      if (!onLoadTranscriptGap) return
      const gapKey = runtimeTranscriptGapKey(gap)
      if (loadingTranscriptGapKeyRef.current !== null) return
      if (reason === 'visible') {
        if (autoLoadedTranscriptGapKeysRef.current.has(gapKey)) return
        autoLoadedTranscriptGapKeysRef.current.add(gapKey)
      }

      preserveScrollPositionForNextLayout()
      loadingTranscriptGapKeyRef.current = gapKey
      setLoadingTranscriptGapKey(gapKey)
      try {
        await onLoadTranscriptGap(gap)
      } catch (error) {
        console.error('[Wework] Message area transcript gap load failed', {
          gap,
          gapKey,
          reason,
          error,
        })
      } finally {
        loadingTranscriptGapKeyRef.current = null
        setLoadingTranscriptGapKey(current => (current === gapKey ? null : current))
      }
    },
    [onLoadTranscriptGap, preserveScrollPositionForNextLayout]
  )

  useEffect(() => {
    autoLoadedTranscriptGapKeysRef.current.clear()
  }, [currentScrollKey])

  const renderTranscriptGapAfterMessage = useCallback(
    (message: WorkbenchMessage, nextMessage: WorkbenchMessage | undefined) => {
      const gap = runtimeTranscriptGapBetween(message, nextMessage, loadedTranscriptRanges)
      if (!gap) return null
      const gapKey = runtimeTranscriptGapKey(gap)
      return (
        <RuntimeTranscriptGapMarker
          key={gapKey}
          gap={gap}
          loading={loadingTranscriptGapKey === gapKey}
          scrollRef={scrollRef}
          onLoad={onLoadTranscriptGap ? loadTranscriptGap : undefined}
        />
      )
    },
    [
      loadTranscriptGap,
      onLoadTranscriptGap,
      loadedTranscriptRanges,
      loadingTranscriptGapKey,
      scrollRef,
    ]
  )

  const saveCurrentScrollPosition = useCallback(() => {
    const element = activeScrollRefRef.current.current
    if (!element || currentScrollKey === null || messages.length === 0) return
    setConversationScrollSnapshot(currentScrollKey, createScrollSnapshot(element, bottomOrigin))
  }, [bottomOrigin, currentScrollKey, messages.length])

  const saveCurrentScrollPositionWithoutLayout = useCallback(() => {
    const element = activeScrollRefRef.current.current
    if (!element || currentScrollKey === null || messages.length === 0) return

    const measuredSnapshot = lastMeasuredScrollSnapshotRef.current
    if (measuredSnapshot?.key === currentScrollKey) {
      setConversationScrollSnapshot(currentScrollKey, measuredSnapshot.snapshot)
      return
    }

    const existingSnapshot = getConversationScrollSnapshot(currentScrollKey)
    setConversationScrollSnapshot(currentScrollKey, {
      distanceFromBottomPx: existingSnapshot?.distanceFromBottomPx ?? 0,
      pinnedToBottom: existingSnapshot?.pinnedToBottom ?? isAtBottomRef.current,
    })
  }, [currentScrollKey, messages.length])

  useLayoutEffect(
    () => () => {
      saveCurrentScrollPositionWithoutLayout()
    },
    [saveCurrentScrollPositionWithoutLayout]
  )

  const updateScrollState = useCallback(
    (options: { forceSave?: boolean; skipSave?: boolean } = {}) => {
      const element = activeScrollRefRef.current.current
      if (!element) return

      if (messages.length === 0) {
        isAtBottomRef.current = true
        setShowScrollButton(false)
        return
      }

      const overflow = element.scrollHeight > element.clientHeight + 8
      const distanceToBottom = getDistanceFromBottom(element, bottomOrigin)
      const isAtBottom = distanceToBottom <= BOTTOM_THRESHOLD
      const isScrolledToBottom = distanceToBottom <= SCROLLED_TO_BOTTOM_THRESHOLD
      if (currentScrollKey !== null) {
        lastMeasuredScrollSnapshotRef.current = {
          key: currentScrollKey,
          snapshot: {
            distanceFromBottomPx: Math.max(0, distanceToBottom),
            pinnedToBottom: isScrolledToBottom,
          },
        }
      }
      const scrollPosition = getDistanceFromTop(element, bottomOrigin)
      const previousScrollPosition = lastScrollPositionRef.current
      const scrolledUp =
        previousScrollPosition !== null && scrollPosition < previousScrollPosition - 0.5
      lastScrollPositionRef.current = scrollPosition
      isAtBottomRef.current = isAtBottom
      const pausedBeforeUpdate = userScrollPausedAutoFollowRef.current
      // Anchor restoration can emit a clamped scroll event at the bottom. Only a downward
      // user scroll may release an existing pause; explicit follow paths clear the pause
      // themselves. An upward user scroll that has not yet crossed the bottom threshold must
      // keep the pause so the follow engine does not yank the viewport back to the bottom.
      if (isScrolledToBottom && !scrolledUp && (!pausedBeforeUpdate || options.forceSave)) {
        userScrollPausedAutoFollowRef.current = false
        clearUserViewportAnchor()
      } else if (options.forceSave) {
        userScrollPausedAutoFollowRef.current = true
      }
      if (!isScrolledToBottom && options.forceSave) {
        if (scrolledUp) {
          clearScheduledScrolls()
        }
        preserveLatestUserTurnRef.current = false
      }
      if (!options.skipSave) {
        saveCurrentScrollPosition()
      }
      setShowScrollButton(overflow && !isAtBottom)
    },
    [
      bottomOrigin,
      clearScheduledScrolls,
      clearUserViewportAnchor,
      currentScrollKey,
      messages.length,
      saveCurrentScrollPosition,
    ]
  )

  const restorePendingLayoutScrollPosition = useCallback(() => {
    const scroller = activeScrollRefRef.current.current
    const pending = pendingLayoutScrollPositionRef.current
    if (!scroller || !pending) {
      return false
    }
    if (pending.conversationKey !== currentScrollKey) {
      releasePendingLayoutScrollPosition()
      return false
    }
    if (Math.abs(scroller.scrollHeight - pending.scrollHeightPx) < 0.5) {
      return false
    }

    releasePendingLayoutScrollPosition()
    const preserveTop = pending.distanceFromTopPx !== undefined
    const distanceFromBottomPx =
      pending.distanceFromTopPx === undefined
        ? pending.distanceFromBottomPx
        : scroller.scrollHeight - scroller.clientHeight - pending.distanceFromTopPx
    setDistanceFromBottom(scroller, distanceFromBottomPx, 'auto', bottomOrigin)
    lastScrollPositionRef.current = getDistanceFromTop(scroller, bottomOrigin)
    updateScrollState({ skipSave: !preserveTop, forceSave: preserveTop })
    return true
  }, [bottomOrigin, currentScrollKey, releasePendingLayoutScrollPosition, updateScrollState])

  const setScrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto', options: { saveSnapshot?: boolean } = {}) => {
      const element = activeScrollRefRef.current.current
      if (!element) return
      stopStreamingFollow()

      if (bottomOrigin) {
        setDistanceFromBottom(element, 0, behavior, true)
      } else if (typeof element.scrollTo === 'function') {
        element.scrollTo({ top: element.scrollHeight, behavior })
      } else {
        element.scrollTop = element.scrollHeight
      }
      lastScrollPositionRef.current = getDistanceFromTop(element, bottomOrigin)
      if (currentScrollKey !== null) {
        const distanceFromBottomPx = options.saveSnapshot
          ? 0
          : getDistanceFromBottom(element, bottomOrigin)
        const snapshot = {
          distanceFromBottomPx,
          pinnedToBottom:
            options.saveSnapshot || distanceFromBottomPx <= SCROLLED_TO_BOTTOM_THRESHOLD,
        }
        lastMeasuredScrollSnapshotRef.current = {
          key: currentScrollKey,
          snapshot,
        }
        if (options.saveSnapshot) {
          setConversationScrollSnapshot(currentScrollKey, snapshot)
        }
      }
      isAtBottomRef.current = true
      userScrollPausedAutoFollowRef.current = false
      clearUserViewportAnchor()
      setShowScrollButton(false)
    },
    [bottomOrigin, clearUserViewportAnchor, currentScrollKey, stopStreamingFollow]
  )

  const restoreSavedScrollPosition = useCallback(
    (key: string, snapshot = getConversationScrollSnapshot(key)) => {
      const element = activeScrollRefRef.current.current
      if (!element || !snapshot) return

      setDistanceFromBottom(
        element,
        snapshot.pinnedToBottom ? 0 : snapshot.distanceFromBottomPx,
        'auto',
        bottomOrigin
      )
      lastScrollPositionRef.current = getDistanceFromTop(element, bottomOrigin)

      const overflow = element.scrollHeight > element.clientHeight + 8
      const distanceToBottom = getDistanceFromBottom(element, bottomOrigin)
      const isAtBottom = distanceToBottom <= BOTTOM_THRESHOLD
      const isScrolledToBottom = distanceToBottom <= SCROLLED_TO_BOTTOM_THRESHOLD
      lastMeasuredScrollSnapshotRef.current = {
        key,
        snapshot: {
          distanceFromBottomPx: Math.max(0, distanceToBottom),
          pinnedToBottom: isScrolledToBottom,
        },
      }
      isAtBottomRef.current = isAtBottom
      userScrollPausedAutoFollowRef.current = !isScrolledToBottom
      setShowScrollButton(overflow && !isAtBottom)
      setConversationScrollSnapshot(key, snapshot)
    },
    [bottomOrigin]
  )

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto', options: { saveSnapshot?: boolean } = {}) => {
      const element = activeScrollRefRef.current.current
      if (!element) return

      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
      }

      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null
        setScrollToBottom(behavior, options)
      })
    },
    [setScrollToBottom]
  )

  const followStreamingToBottom = useCallback(() => {
    const element = activeScrollRefRef.current.current
    if (!element) return
    if (
      !streamingFollowActive ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    ) {
      setScrollToBottom('auto', { saveSnapshot: false })
      return
    }
    if (streamingFollowFrameRef.current !== null) return

    followingBottomKeyRef.current = currentScrollKey
    streamingFollowOwnedRef.current = true
    const advanceFrame = (now: number) => {
      streamingFollowFrameRef.current = null
      if (
        userScrollPausedAutoFollowRef.current ||
        autoScrollSuspended ||
        isTurnNavigationAutoScrollSuspended()
      ) {
        stopStreamingFollow()
        return
      }

      const topOriginTarget = Math.max(0, element.scrollHeight - element.clientHeight)
      const lag = bottomOrigin
        ? getDistanceFromBottom(element, true)
        : Math.max(0, topOriginTarget - element.scrollTop)
      if (lag <= STREAM_FOLLOW_SETTLE_PX) {
        if (bottomOrigin) {
          setDistanceFromBottom(element, 0, 'auto', true)
        } else {
          element.scrollTo?.({ top: topOriginTarget, behavior: 'auto' })
          element.scrollTop = topOriginTarget
        }
        lastScrollPositionRef.current = getDistanceFromTop(element, bottomOrigin)
        isAtBottomRef.current = true
        stopStreamingFollow()
        return
      }

      const previousFrameAt = streamingFollowLastFrameAtRef.current
      streamingFollowLastFrameAtRef.current = now
      const step = computeStreamingScrollStep(
        lag,
        streamingFollowVelocityRef.current,
        previousFrameAt === null ? 16 : now - previousFrameAt
      )
      streamingFollowVelocityRef.current = step.velocityPxPerSecond
      if (bottomOrigin) {
        setDistanceFromBottom(element, Math.max(0, lag - step.advancePx), 'auto', true)
      } else {
        const nextScrollTop = Math.min(topOriginTarget, element.scrollTop + step.advancePx)
        element.scrollTo?.({ top: nextScrollTop, behavior: 'auto' })
        element.scrollTop = nextScrollTop
      }
      lastScrollPositionRef.current = getDistanceFromTop(element, bottomOrigin)
      isAtBottomRef.current = true
      userScrollPausedAutoFollowRef.current = false
      setShowScrollButton(false)
      streamingFollowFrameRef.current = requestSafeAnimationFrame(advanceFrame)
    }

    streamingFollowFrameRef.current = requestSafeAnimationFrame(advanceFrame)
  }, [
    autoScrollSuspended,
    bottomOrigin,
    currentScrollKey,
    isTurnNavigationAutoScrollSuspended,
    setScrollToBottom,
    stopStreamingFollow,
    streamingFollowActive,
  ])

  const markCurrentConversationPinnedToBottom = useCallback(() => {
    if (currentScrollKey === null) return
    const snapshot = {
      distanceFromBottomPx: 0,
      pinnedToBottom: true,
    }
    lastMeasuredScrollSnapshotRef.current = {
      key: currentScrollKey,
      snapshot,
    }
    setConversationScrollSnapshot(currentScrollKey, snapshot)
  }, [currentScrollKey])

  const adoptVirtualBottomPosition = useCallback(() => {
    clearScheduledScrolls()
    virtualInitialPositionOwnerRef.current = { key: currentScrollKey }
    restoredScrollSnapshotRef.current = null
    followingBottomKeyRef.current = currentScrollKey
    markCurrentConversationPinnedToBottom()
    const element = activeScrollRefRef.current.current
    lastScrollPositionRef.current = element ? getDistanceFromTop(element, bottomOrigin) : null
    isAtBottomRef.current = true
    userScrollPausedAutoFollowRef.current = false
    clearUserViewportAnchor()
    requestAnimationFrame(() => setShowScrollButton(false))
  }, [
    bottomOrigin,
    clearScheduledScrolls,
    clearUserViewportAnchor,
    currentScrollKey,
    markCurrentConversationPinnedToBottom,
  ])

  /**
   * Releases the explicit jump-to-bottom ownership once the viewport actually reaches the bottom.
   *
   * The ownership must not be given up at a fixed point in time, because a response that keeps growing
   * would leave the viewport mid-conversation. So this window is restarted by every layout change that
   * lands while the ownership is held (`handleContentLayoutChange`), which keeps a follow that outlived
   * one budget owned until the growth stops — and then hands the viewport back.
   */
  const scheduleBottomFollowRelease = useCallback(() => {
    if (bottomFollowReleasePendingRef.current) return
    bottomFollowReleasePendingRef.current = true
    const releaseCheck = (attempt: number) => {
      if (followingBottomKeyRef.current !== currentScrollKey) {
        bottomFollowReleasePendingRef.current = false
        return
      }
      const element = activeScrollRefRef.current.current
      const distanceToBottom = element
        ? getDistanceFromBottom(element, bottomOrigin)
        : Number.POSITIVE_INFINITY
      if (
        distanceToBottom <= SCROLLED_TO_BOTTOM_THRESHOLD &&
        !userScrollPausedAutoFollowRef.current
      ) {
        followingBottomKeyRef.current = null
        explicitBottomFollowRef.current = false
        preserveLatestUserTurnRef.current = false
        bottomFollowReleasePendingRef.current = false
        return
      }
      // The viewport has not reached the bottom yet (content kept growing while the view was pinned).
      // Keep the explicit bottom follow and re-check after another stable window instead of dropping
      // the pin and letting the view linger mid-flight.
      if (attempt < STABLE_SCROLL_RELEASE_RETRIES) {
        scheduleScrollTimer(() => releaseCheck(attempt + 1), Math.max(...STABLE_SCROLL_DELAYS) + 50)
        return
      }
      // The window ran out short of the bottom. While the response is still growing the follow stays
      // owned and the next layout change restarts this window; once the growth stopped the ownership
      // is stale, so hand the viewport back instead of pinning it forever.
      bottomFollowReleasePendingRef.current = false
      if (!streamingFollowActive) {
        followingBottomKeyRef.current = null
        explicitBottomFollowRef.current = false
        preserveLatestUserTurnRef.current = false
      }
    }
    scheduleScrollTimer(() => releaseCheck(0), Math.max(...STABLE_SCROLL_DELAYS) + 50)
  }, [bottomOrigin, currentScrollKey, scheduleScrollTimer, streamingFollowActive])

  const scheduleStableScrollToBottom = useCallback(
    (
      behavior: ScrollBehavior = 'auto',
      options: { saveSnapshot?: boolean; releaseAfterStable?: boolean } = {}
    ) => {
      clearScheduledScrolls()
      followingBottomKeyRef.current = currentScrollKey
      markCurrentConversationPinnedToBottom()
      STABLE_SCROLL_DELAYS.forEach(delay => {
        scheduleScrollTimer(() => {
          scrollToBottom(behavior, options)
        }, delay)
      })
      if (options.releaseAfterStable) {
        scheduleBottomFollowRelease()
      }
    },
    [
      clearScheduledScrolls,
      currentScrollKey,
      markCurrentConversationPinnedToBottom,
      scheduleBottomFollowRelease,
      scheduleScrollTimer,
      scrollToBottom,
    ]
  )

  return {
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
  }
}
