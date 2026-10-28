import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { computeStreamingScrollStep, STREAM_FOLLOW_SETTLE_PX } from './streamingScrollFollow'
import {
  getConversationScrollSnapshot,
  type ConversationScrollSnapshot,
} from './conversationViewportCache'
import {
  getDistanceFromBottom,
  isConversationScrollInput,
  setDistanceFromBottom,
} from './conversationViewportScroll'
import {
  BOTTOM_THRESHOLD,
  SCROLLED_TO_BOTTOM_THRESHOLD,
  type ScrollableMessageAreaProps,
  type UserViewportAnchor,
  type RuntimeTranscriptGap,
} from './scrollableMessageTypes'
import {
  createScrollSnapshot,
  findLatestGuidanceMessageId,
  findLatestUserMessageId,
  restoreConversationAnchor,
  scrollPositionKey,
  setConversationScrollSnapshot,
} from './conversationScrollGeometry'
import { useReaderViewportAnchor } from './useReaderViewportAnchor'
import type { ConversationVirtualizer } from './useConversationVirtualizer'
import {
  RuntimeTranscriptGapMarker,
  runtimeTranscriptGapBetween,
  runtimeTranscriptGapKey,
} from './RuntimeTranscriptGapMarker'
import { recordConversationScrollDiagnostic } from './conversationDiagnostics'
import {
  CONVERSATION_SCROLL_WRITE_SOURCE,
  recordConversationScrollWrite,
} from './conversationScrollWrite'
import {
  requestSafeAnimationFrame,
  cancelSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from '../markdown/safeAnimationFrame'

type Options = Pick<
  ScrollableMessageAreaProps,
  | 'messages'
  | 'externalScrollRef'
  | 'externalScrollInteractionRef'
  | 'loading'
  | 'isWaitingForAssistant'
  | 'conversationKey'
  | 'onLoadTranscriptGap'
  | 'loadedTranscriptRanges'
  | 'autoScrollSuspended'
  | 'initialScrollPosition'
>
type ViewportMode = 'follow' | 'read' | 'navigate' | 'drag'

/** Application semantics only. Row geometry and ordinary prepend/append belong to TanStack. */
export function useConversationScrollController({
  messages,
  externalScrollRef,
  externalScrollInteractionRef,
  loading,
  isWaitingForAssistant,
  conversationKey,
  onLoadTranscriptGap,
  loadedTranscriptRanges,
  autoScrollSuspended,
  initialScrollPosition,
}: Options) {
  const internalScrollRef = useRef<HTMLDivElement>(null)
  const scrollRef = externalScrollRef ?? internalScrollRef
  const activeScrollRefRef = useRef(scrollRef)
  activeScrollRefRef.current = scrollRef
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyFooterRef = useRef<HTMLDivElement>(null)
  const contentFooterRef = useRef<HTMLDivElement>(null)
  const [scrollTailHeight, setScrollTailHeight] = useState(0)
  const virtualizerRef = useRef<ConversationVirtualizer | null>(null)
  const currentScrollKey = scrollPositionKey(conversationKey)
  const identityRef = useRef(currentScrollKey)
  identityRef.current = currentScrollKey
  const [mode, setMode] = useState<ViewportMode>('follow')
  const [motionActive, setMotionActive] = useState(false)
  const modeRef = useRef<ViewportMode>('follow')
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [turnNavigationLoading, setTurnNavigationLoading] = useState(false)
  const [turnNavigationTargetMessageId, setTurnNavigationTargetMessageId] = useState<string | null>(
    null
  )
  const navigationLoadingRef = useRef(false)
  const navigationTargetRef = useRef<string | null>(null)
  const userViewportAnchorRef = useRef<UserViewportAnchor | null>(null)
  const selfScrollOffsetRef = useRef(0)
  const lastMeasuredLayoutRef = useRef<string | null>(null)
  const lastScrollPositionRef = useRef<number | null>(null)
  const lastSnapshotRef = useRef<{
    key: string | null
    snapshot: ConversationScrollSnapshot
  } | null>(null)
  const restoringRef = useRef<ConversationScrollSnapshot | null>(null)
  const restoreNeedsDistanceRef = useRef(false)
  const inputRef = useRef(false)
  const inputDirectionRef = useRef<'backward' | 'forward' | null>(null)
  const motionRef = useRef<{
    frame: SafeAnimationFrameHandle | null
    velocity: number
    at: number | null
  }>({ frame: null, velocity: 0, at: null })
  const initializedKeyRef = useRef<string | null | undefined>(undefined)
  const commandRef = useRef(false)
  const latestRef = useRef({ autoScrollSuspended, streaming: false })
  latestRef.current = {
    autoScrollSuspended,
    streaming: messages.some(message => message.status === 'streaming'),
  }
  const { captureUserViewportAnchor, restoreReaderPositionFromLayout } = useReaderViewportAnchor({
    activeScrollRefRef,
    contentRef,
    userViewportAnchorRef,
    selfScrollOffsetRef,
    lastMeasuredLayoutRef,
    lastScrollPositionRef,
  })

  const clearAnchor = useCallback(() => {
    userViewportAnchorRef.current = null
    selfScrollOffsetRef.current = 0
    lastMeasuredLayoutRef.current = null
  }, [])
  const cancelMotion = useCallback(() => {
    const motion = motionRef.current
    if (motion.frame !== null) cancelSafeAnimationFrame(motion.frame)
    motion.frame = null
    motion.velocity = 0
    motion.at = null
    setMotionActive(false)
    virtualizerRef.current?.cancelScroll()
  }, [])
  const changeMode = useCallback((next: ViewportMode) => {
    modeRef.current = next
    setMode(next)
    // Disable both append follow and resize-at-end before the next React commit.
    const engine = virtualizerRef.current
    if (engine && next !== 'follow') {
      engine.cancelScroll()
      engine.shouldAdjustScrollPositionOnItemSizeChange = next === 'read' ? undefined : () => false
      engine.setOptions({
        ...engine.options,
        anchorTo: next === 'navigate' || next === 'drag' ? 'start' : 'end',
        followOnAppend: false,
        scrollEndThreshold: -1,
      })
    }
  }, [])
  const onVirtualScrollAdjustment = useCallback((delta: number) => {
    if (!commandRef.current && userViewportAnchorRef.current) selfScrollOffsetRef.current += delta
  }, [])
  const writeOffset = useCallback((top: number) => {
    const viewport = activeScrollRefRef.current.current
    if (!viewport) return
    commandRef.current = true
    const engine = virtualizerRef.current
    if (engine) {
      engine.cancelScroll()
      engine.scrollToOffset(top, { behavior: 'auto' })
    } else
      recordConversationScrollWrite(
        viewport,
        CONVERSATION_SCROLL_WRITE_SOURCE.controllerBottom,
        top,
        () => {
          if (typeof viewport.scrollTo === 'function') viewport.scrollTo({ top, behavior: 'auto' })
          else viewport.scrollTop = top
        }
      )
    commandRef.current = false
    lastScrollPositionRef.current = viewport.scrollTop
  }, [])
  const save = useCallback(() => {
    const viewport = activeScrollRefRef.current.current
    if (!viewport || messages.length === 0 || latestRef.current.autoScrollSuspended) return
    const snapshot: ConversationScrollSnapshot =
      modeRef.current === 'follow'
        ? { pinnedToBottom: true, distanceFromBottomPx: 0 }
        : modeRef.current === 'drag'
          ? { pinnedToBottom: false, distanceFromBottomPx: getDistanceFromBottom(viewport) }
          : createScrollSnapshot(viewport)
    if (modeRef.current === 'read' || modeRef.current === 'drag') snapshot.pinnedToBottom = false
    if (modeRef.current === 'follow') {
      snapshot.pinnedToBottom = true
      snapshot.distanceFromBottomPx = 0
      delete snapshot.anchor
    }
    lastSnapshotRef.current = { key: currentScrollKey, snapshot }
    if (currentScrollKey) setConversationScrollSnapshot(currentScrollKey, snapshot)
    setShowScrollButton(getDistanceFromBottom(viewport) > BOTTOM_THRESHOLD)
  }, [currentScrollKey, messages.length])
  const follow = useCallback(
    (smooth = false) => {
      if (
        modeRef.current !== 'follow' ||
        latestRef.current.autoScrollSuspended ||
        navigationLoadingRef.current ||
        navigationTargetRef.current
      )
        return
      const viewport = activeScrollRefRef.current.current
      if (!viewport) return
      if (getDistanceFromBottom(viewport) < 1) {
        cancelMotion()
        save()
        return
      }
      const animate = smooth || latestRef.current.streaming || motionRef.current.frame !== null
      if (!animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        cancelMotion()
        writeOffset(Math.max(0, viewport.scrollHeight - viewport.clientHeight))
        save()
        return
      }
      if (motionRef.current.frame !== null) return
      const engine = virtualizerRef.current
      if (engine) {
        engine.cancelScroll()
        engine.setOptions({ ...engine.options, followOnAppend: false, scrollEndThreshold: -1 })
      }
      setMotionActive(true)
      const key = identityRef.current
      const advance = (now: number) => {
        const motion = motionRef.current
        motion.frame = null
        if (
          key !== identityRef.current ||
          modeRef.current !== 'follow' ||
          latestRef.current.autoScrollSuspended ||
          navigationLoadingRef.current ||
          navigationTargetRef.current
        ) {
          cancelMotion()
          return
        }
        const end = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
        const lag = Math.max(0, end - viewport.scrollTop)
        if (lag <= STREAM_FOLLOW_SETTLE_PX) {
          writeOffset(end)
          cancelMotion()
          save()
          return
        }
        const step = computeStreamingScrollStep(
          lag,
          motion.velocity,
          motion.at === null ? 16 : now - motion.at
        )
        motion.at = now
        motion.velocity = step.velocityPxPerSecond
        writeOffset(Math.min(end, viewport.scrollTop + step.advancePx))
        setShowScrollButton(false)
        motion.frame = requestSafeAnimationFrame(advance)
      }
      motionRef.current.frame = requestSafeAnimationFrame(advance)
    },
    [cancelMotion, save, writeOffset]
  )
  const handleContentLayoutChange = useCallback(() => {
    setScrollTailHeight(
      (contentFooterRef.current?.offsetHeight ?? 0) + (stickyFooterRef.current?.offsetHeight ?? 0)
    )
    if (initializedKeyRef.current !== currentScrollKey) return
    if (
      latestRef.current.autoScrollSuspended ||
      modeRef.current === 'navigate' ||
      modeRef.current === 'drag'
    )
      return
    const viewport = activeScrollRefRef.current.current
    if (!viewport) return
    const snapshot = restoringRef.current
    if (snapshot && !snapshot.pinnedToBottom) {
      if (restoreNeedsDistanceRef.current || !snapshot.anchor) {
        setDistanceFromBottom(viewport, snapshot.distanceFromBottomPx, 'auto')
        restoreNeedsDistanceRef.current = false
      }
      restoreConversationAnchor(viewport, snapshot)
    } else if (modeRef.current === 'read') restoreReaderPositionFromLayout()
    else follow()
  }, [currentScrollKey, follow, restoreReaderPositionFromLayout])
  const preserveScrollPositionForNextLayout = useCallback(() => {
    cancelMotion()
    if (modeRef.current === 'drag') return
    restoringRef.current = null
    changeMode('read')
    captureUserViewportAnchor()
  }, [cancelMotion, captureUserViewportAnchor, changeMode])
  const preserveUserMessagePosition = preserveScrollPositionForNextLayout
  const finishNavigation = useCallback(() => {
    if (navigationLoadingRef.current || navigationTargetRef.current) return
    if (modeRef.current !== 'navigate') return
    const viewport = activeScrollRefRef.current.current
    if (!viewport) return
    restoringRef.current = null
    const nextMode =
      getDistanceFromBottom(viewport) <= SCROLLED_TO_BOTTOM_THRESHOLD ? 'follow' : 'read'
    changeMode(nextMode)
    clearAnchor()
    if (nextMode === 'read') captureUserViewportAnchor()
    save()
  }, [captureUserViewportAnchor, changeMode, clearAnchor, save])
  const handleTurnNavigationScrollTargetChange = useCallback(
    (messageId: string | null) => {
      if (identityRef.current !== currentScrollKey) return
      const wasNavigating = navigationTargetRef.current !== null
      navigationTargetRef.current = messageId
      setTurnNavigationTargetMessageId(messageId)
      if (messageId) {
        cancelMotion()
        changeMode('navigate')
        clearAnchor()
        restoringRef.current = null
      } else if (wasNavigating) finishNavigation()
    },
    [cancelMotion, changeMode, clearAnchor, currentScrollKey, finishNavigation]
  )
  const handleTurnNavigationLoadStateChange = useCallback(
    (loading: boolean) => {
      if (identityRef.current !== currentScrollKey) return
      const wasLoading = navigationLoadingRef.current
      navigationLoadingRef.current = loading
      setTurnNavigationLoading(loading)
      if (loading) {
        cancelMotion()
        changeMode('navigate')
      } else if (wasLoading) finishNavigation()
    },
    [cancelMotion, changeMode, currentScrollKey, finishNavigation]
  )

  const previousRef = useRef<{
    key: string | null
    count: number
    user: string | null
    guidance: string | null
    loading: boolean
  } | null>(null)
  useLayoutEffect(() => {
    const previous = previousRef.current
    const user = findLatestUserMessageId(messages)
    const guidance = findLatestGuidanceMessageId(messages)
    const changed = !previous || previous.key !== currentScrollKey
    const loaded = previous?.count === 0 && messages.length > 0
    const sent =
      !changed &&
      !loading &&
      !previous.loading &&
      ((previous.user !== null && user !== previous.user) ||
        (previous.count === 0 && messages.at(-1)?.role === 'user') ||
        (guidance !== null && guidance !== previous.guidance))
    previousRef.current = {
      key: currentScrollKey,
      count: messages.length,
      user,
      guidance,
      loading: Boolean(loading),
    }
    if (changed) {
      cancelMotion()
      clearAnchor()
      restoringRef.current = null
      inputRef.current = false
      navigationTargetRef.current = null
      navigationLoadingRef.current = false
    }
    initializedKeyRef.current = currentScrollKey
    if (
      (changed || loaded) &&
      messages.length > 0 &&
      !(loaded && !changed && modeRef.current === 'read')
    ) {
      const snapshot =
        initialScrollPosition === 'latest'
          ? undefined
          : currentScrollKey
            ? getConversationScrollSnapshot(currentScrollKey)
            : undefined
      restoringRef.current = snapshot && !snapshot.pinnedToBottom ? snapshot : null
      restoreNeedsDistanceRef.current = restoringRef.current !== null
      changeMode(snapshot && !snapshot.pinnedToBottom ? 'read' : 'follow')
      const viewport = activeScrollRefRef.current.current
      if (viewport && snapshot && !snapshot.pinnedToBottom && !autoScrollSuspended) {
        setDistanceFromBottom(viewport, snapshot.distanceFromBottomPx, 'auto')
        restoreConversationAnchor(viewport, snapshot)
      }
    }
    if (sent) {
      cancelMotion()
      clearAnchor()
      restoringRef.current = null
      changeMode('follow')
    }
    handleContentLayoutChange()
  }, [
    autoScrollSuspended,
    cancelMotion,
    changeMode,
    clearAnchor,
    currentScrollKey,
    handleContentLayoutChange,
    initialScrollPosition,
    isWaitingForAssistant,
    loading,
    messages,
  ])
  useEffect(() => {
    const viewport = scrollRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const observer = new ResizeObserver(handleContentLayoutChange)
    observer.observe(viewport)
    observer.observe(content)
    if (stickyFooterRef.current) observer.observe(stickyFooterRef.current)
    if (contentFooterRef.current) observer.observe(contentFooterRef.current)
    // External host refs are attached after the child's layout effects.
    handleContentLayoutChange()
    return () => observer.disconnect()
  }, [handleContentLayoutChange, scrollRef])

  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    const interaction = externalScrollInteractionRef?.current
    let pointerStepObserved = true
    const markInput = (event: Event) => {
      if (!isConversationScrollInput(event)) return
      if (modeRef.current === 'read') restoreReaderPositionFromLayout()
      cancelMotion()
      restoringRef.current = null
      inputRef.current = true
      inputDirectionRef.current =
        event instanceof WheelEvent && event.deltaY !== 0
          ? event.deltaY < 0
            ? 'backward'
            : 'forward'
          : event instanceof KeyboardEvent
            ? ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
              ? 'backward'
              : 'forward'
            : null
      pointerStepObserved = false
      recordConversationScrollDiagnostic('scroll-input', viewport, {
        deltaY: event instanceof WheelEvent ? event.deltaY : null,
        paused: modeRef.current === 'read',
      })
      lastScrollPositionRef.current = viewport.scrollTop
      const scrollbarPointer =
        interaction?.contains(event.target as Node) && event instanceof PointerEvent
      if (scrollbarPointer) {
        changeMode('drag')
        clearAnchor()
      } else captureUserViewportAnchor()
      if (event instanceof WheelEvent && event.deltaY < 0) changeMode('read')
      if (event instanceof KeyboardEvent && ['ArrowUp', 'PageUp', 'Home'].includes(event.key))
        changeMode('read')
    }
    const scroll = () => {
      if (latestRef.current.autoScrollSuspended || modeRef.current === 'navigate') return
      if (modeRef.current === 'drag') {
        lastScrollPositionRef.current = viewport.scrollTop
        pointerStepObserved = true
        save()
        return
      }
      if (inputRef.current) {
        const previous = lastScrollPositionRef.current ?? viewport.scrollTop
        const upward =
          inputDirectionRef.current === 'backward' ||
          (inputDirectionRef.current === null && viewport.scrollTop < previous - 0.5)
        changeMode(
          !upward && getDistanceFromBottom(viewport) <= SCROLLED_TO_BOTTOM_THRESHOLD
            ? 'follow'
            : 'read'
        )
        lastScrollPositionRef.current = viewport.scrollTop
        restoreReaderPositionFromLayout()
        save()
        pointerStepObserved = true
      } else if (modeRef.current === 'read') handleContentLayoutChange()
      else follow()
    }
    const endInput = () => {
      if (modeRef.current === 'drag') return
      inputRef.current = false
      save()
    }
    const endDrag = () => {
      if (modeRef.current !== 'drag') return
      inputRef.current = false
      const nextMode =
        getDistanceFromBottom(viewport) <= SCROLLED_TO_BOTTOM_THRESHOLD ? 'follow' : 'read'
      changeMode(nextMode)
      clearAnchor()
      if (nextMode === 'read') captureUserViewportAnchor()
      save()
    }
    const drag = (event: PointerEvent) => {
      if (event.buttons === 1 && pointerStepObserved) markInput(event)
    }
    const targets = interaction ? [viewport, interaction] : [viewport]
    targets.forEach(target => {
      target.addEventListener('wheel', markInput, { passive: true })
      target.addEventListener('pointerdown', markInput, { capture: true })
      target.addEventListener('touchstart', markInput, { passive: true })
      target.addEventListener('keydown', markInput, { capture: true })
    })
    interaction?.addEventListener('pointermove', drag, { capture: true })
    viewport.addEventListener('scroll', scroll, { passive: true })
    viewport.addEventListener('scrollend', endInput)
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      window.addEventListener(type, endDrag)
    return () => {
      targets.forEach(target => {
        target.removeEventListener('wheel', markInput)
        target.removeEventListener('pointerdown', markInput, true)
        target.removeEventListener('touchstart', markInput)
        target.removeEventListener('keydown', markInput, true)
      })
      interaction?.removeEventListener('pointermove', drag, true)
      viewport.removeEventListener('scroll', scroll)
      viewport.removeEventListener('scrollend', endInput)
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
        window.removeEventListener(type, endDrag)
    }
  }, [
    cancelMotion,
    captureUserViewportAnchor,
    changeMode,
    clearAnchor,
    externalScrollInteractionRef,
    follow,
    handleContentLayoutChange,
    restoreReaderPositionFromLayout,
    save,
    scrollRef,
  ])
  useLayoutEffect(
    () => () => {
      cancelMotion()
      const measured = lastSnapshotRef.current
      if (currentScrollKey && measured?.key === currentScrollKey)
        setConversationScrollSnapshot(currentScrollKey, measured.snapshot)
    },
    [cancelMotion, currentScrollKey]
  )
  const handleScrollToBottom = useCallback(() => {
    cancelMotion()
    clearAnchor()
    restoringRef.current = null
    inputRef.current = false
    changeMode('follow')
    save()
    follow(true)
  }, [cancelMotion, changeMode, clearAnchor, follow, save])

  const loadingTranscriptGapKeyRef = useRef<string | null>(null)
  const gapLoadOwnerRef = useRef<object | null>(null)
  const autoLoadedTranscriptGapKeysRef = useRef(new Set<string>())
  const [loadingTranscriptGapKey, setLoadingTranscriptGapKey] = useState<string | null>(null)
  const loadTranscriptGap = useCallback(
    async (gap: RuntimeTranscriptGap, reason: 'visible' | 'click') => {
      if (!onLoadTranscriptGap || loadingTranscriptGapKeyRef.current) return
      const gapKey = runtimeTranscriptGapKey(gap)
      if (reason === 'visible') {
        if (autoLoadedTranscriptGapKeysRef.current.has(gapKey)) return
        autoLoadedTranscriptGapKeysRef.current.add(gapKey)
      }
      preserveScrollPositionForNextLayout()
      const key = currentScrollKey
      const owner = {}
      gapLoadOwnerRef.current = owner
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
        if (identityRef.current === key && gapLoadOwnerRef.current === owner) {
          gapLoadOwnerRef.current = null
          loadingTranscriptGapKeyRef.current = null
          setLoadingTranscriptGapKey(current => (current === gapKey ? null : current))
        }
      }
    },
    [currentScrollKey, onLoadTranscriptGap, preserveScrollPositionForNextLayout]
  )
  useEffect(() => {
    autoLoadedTranscriptGapKeysRef.current.clear()
    loadingTranscriptGapKeyRef.current = null
    setLoadingTranscriptGapKey(null)
    return () => {
      gapLoadOwnerRef.current = null
    }
  }, [currentScrollKey])
  const renderTranscriptGapAfterMessage = useCallback(
    (message: WorkbenchMessage, nextMessage: WorkbenchMessage | undefined) => {
      const gap = runtimeTranscriptGapBetween(message, nextMessage, loadedTranscriptRanges)
      return gap ? (
        <RuntimeTranscriptGapMarker
          key={runtimeTranscriptGapKey(gap)}
          gap={gap}
          loading={loadingTranscriptGapKey === runtimeTranscriptGapKey(gap)}
          scrollRef={scrollRef}
          onLoad={onLoadTranscriptGap ? loadTranscriptGap : undefined}
        />
      ) : null
    },
    [
      loadTranscriptGap,
      loadedTranscriptRanges,
      loadingTranscriptGapKey,
      onLoadTranscriptGap,
      scrollRef,
    ]
  )

  return {
    internalScrollRef,
    scrollRef,
    contentRef,
    stickyFooterRef,
    contentFooterRef,
    scrollTailHeight,
    virtualizerRef,
    currentScrollKey,
    showScrollButton,
    turnNavigationLoading,
    turnNavigationTargetMessageId,
    handleTurnNavigationScrollTargetChange,
    handleTurnNavigationLoadStateChange,
    handleContentLayoutChange,
    handleScrollToBottom,
    preserveScrollPositionForNextLayout,
    preserveUserMessagePosition,
    renderTranscriptGapAfterMessage,
    onVirtualScrollAdjustment,
    virtualAnchorToEnd:
      mode === 'follow' && !latestRef.current.streaming && !motionActive && !autoScrollSuspended,
    virtualAnchor: mode === 'navigate' || mode === 'drag' ? ('start' as const) : ('end' as const),
    virtualScrollAdjustmentEnabled: mode === 'read' && !autoScrollSuspended,
  }
}
