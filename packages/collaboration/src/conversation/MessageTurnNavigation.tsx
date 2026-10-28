import {
  requestSafeAnimationFrame,
  cancelSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from '../markdown/safeAnimationFrame'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { useCollaborationPortalTheme } from '../theme/CollaborationTheme'
import {
  MARKER_HIT_AREA_WIDTH_PX,
  MARKER_HOVER_ROW_HEIGHT_PX,
  NAVIGATION_VIEWPORT_PADDING_PX,
} from './turnNavigationConstants'
import {
  buildUserTurnsForNavigation,
  getUserTurnsSignature,
  getNavigationHeight,
  getMarkerTopPx,
  getMarkerWidthPx,
  findUnloadedMarkerBetween,
  getMarkerToneClass,
  scrollToMessageAnchor,
  findMessageAnchor,
  findLoadedNavigationMessageId,
  getMessageAnchorTargetTop,
  getScrollMetrics,
  logTurnNavigation,
  getMessageAnchorById,
  getTurnVisibilityBounds,
  equalStringArrays,
} from './turnNavigationUtils'
import type {
  MessageTurnNavigationProps,
  MessageTurnMarker,
  PendingScrollTarget,
  MeasuredScrollGeometry,
} from './turnNavigationTypes'
import {
  getContentPositionForViewportY,
  getScrollViewportBounds,
  isConversationScrollInput,
  scrollToContentPosition,
} from './conversationViewportScroll'
export function MessageTurnNavigation({
  translate: t,
  messages,
  turnNavigation,
  scrollRef,
  interactionRef,
  contentRef,
  onLoadTurnNavigationItem,
  onNavigationLoadStateChange,
  onNavigationScrollTargetChange,
  portalTarget,
}: MessageTurnNavigationProps) {
  const portalTheme = useCollaborationPortalTheme()
  const [markers, setMarkers] = useState<MessageTurnMarker[]>([])
  const [activeMarkerIds, setActiveMarkerIds] = useState<string[]>([])
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  const [loadingMarkerId, setLoadingMarkerId] = useState<string | null>(null)
  const [pendingScrollTarget, setPendingScrollTarget] = useState<PendingScrollTarget | null>(null)
  const [navigationScrollTop, setNavigationScrollTop] = useState(0)
  const markersRef = useRef<MessageTurnMarker[]>([])
  const timerRef = useRef<number | null>(null)
  const navigationCleanupRef = useRef<(() => void) | null>(null)
  const messagesRef = useRef(messages)
  const turnNavigationRef = useRef(turnNavigation)
  const measuredScrollGeometryRef = useRef<MeasuredScrollGeometry | null>(null)
  const loadOwnerRef = useRef<object | null>(null)
  useEffect(
    () => () => {
      loadOwnerRef.current = null
    },
    []
  )

  const clearNavigationPosition = useCallback(() => {
    navigationCleanupRef.current?.()
    navigationCleanupRef.current = null
  }, [])

  const cancelNavigation = useCallback(() => {
    loadOwnerRef.current = null
    const scroller = scrollRef.current
    if (navigationCleanupRef.current && scroller)
      scrollToContentPosition(scroller, scroller.scrollTop, 'auto')
    clearNavigationPosition()
    setPendingScrollTarget(null)
    setLoadingMarkerId(null)
    onNavigationScrollTargetChange?.(null)
    onNavigationLoadStateChange?.(false)
  }, [
    clearNavigationPosition,
    onNavigationLoadStateChange,
    onNavigationScrollTargetChange,
    scrollRef,
  ])

  useEffect(() => {
    const cancelForInput = (event: Event) => {
      if (
        (!loadOwnerRef.current && !navigationCleanupRef.current) ||
        !isConversationScrollInput(event)
      )
        return
      cancelNavigation()
    }
    const targets = [scrollRef.current, interactionRef?.current].filter(
      (target): target is HTMLElement => target !== null && target !== undefined
    )
    for (const target of targets)
      for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
        target.addEventListener(type, cancelForInput, { capture: true, passive: true })
    return () => {
      for (const target of targets)
        for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
          target.removeEventListener(type, cancelForInput, true)
    }
  }, [cancelNavigation, interactionRef, scrollRef])

  const scrollToMessageId = useCallback(
    (scroller: HTMLDivElement, messageId: string, behavior: ScrollBehavior = 'auto') => {
      clearNavigationPosition()
      const initialAnchor = findMessageAnchor(contentRef, messageId)
      if (!initialAnchor) {
        logTurnNavigation('anchor-missing', {
          messageId,
          behavior,
          ...getScrollMetrics(scroller),
        })
        return
      }
      loadOwnerRef.current = null
      onNavigationScrollTargetChange?.(messageId)
      logTurnNavigation('scroll-start', {
        messageId,
        behavior,
        ...getScrollMetrics(scroller, initialAnchor),
      })
      scrollToMessageAnchor(scroller, initialAnchor, behavior)
      logTurnNavigation('scroll-initial-complete', {
        messageId,
        behavior,
        ...getScrollMetrics(scroller, initialAnchor),
      })

      let settled = false
      let frame: SafeAnimationFrameHandle | null = null
      const cleanup = () => {
        if (frame) cancelSafeAnimationFrame(frame)
        observer.disconnect()
        scroller.removeEventListener('scrollend', finish)
        if (navigationCleanupRef.current === cleanup) navigationCleanupRef.current = null
      }
      const finish = () => {
        if (settled) return
        settled = true
        cleanup()
        onNavigationScrollTargetChange?.(null)
      }
      const check = () => {
        frame = null
        const anchor = findMessageAnchor(contentRef, messageId)
        if (!anchor) {
          finish()
          return
        }
        const target = getMessageAnchorTargetTop(scroller, anchor)
        if (Math.abs(scroller.scrollTop - target) < 1) finish()
      }
      const observer = new ResizeObserver(() => {
        const anchor = findMessageAnchor(contentRef, messageId)
        if (!anchor || settled) return
        scrollToMessageAnchor(scroller, anchor, 'auto')
        if (frame) cancelSafeAnimationFrame(frame)
        frame = requestSafeAnimationFrame(check)
      })
      observer.observe(initialAnchor)
      if (contentRef.current) observer.observe(contentRef.current)
      observer.observe(scroller)
      scroller.addEventListener('scrollend', finish)
      navigationCleanupRef.current = cleanup
      frame = requestSafeAnimationFrame(check)
    },
    [clearNavigationPosition, contentRef, onNavigationScrollTargetChange]
  )

  const nextUserTurns = buildUserTurnsForNavigation(messages, turnNavigation)
  const userTurnsSignature = getUserTurnsSignature(nextUserTurns)

  useLayoutEffect(() => {
    messagesRef.current = messages
    turnNavigationRef.current = turnNavigation
  }, [messages, turnNavigation, userTurnsSignature])

  const updateActiveMarkers = useCallback(
    (nextMarkers: MessageTurnMarker[], reason = 'unknown') => {
      void reason
      const scroller = scrollRef.current
      if (!scroller || nextMarkers.length === 0) {
        setActiveMarkerIds([])
        return
      }

      const viewport = getScrollViewportBounds(scroller)
      const nextActiveMarkerIds = nextMarkers
        .filter(
          marker =>
            marker.visibleTop !== null &&
            marker.visibleBottom !== null &&
            marker.visibleBottom > viewport.startPx &&
            marker.visibleTop < viewport.endPx
        )
        .map(marker => marker.id)
      setActiveMarkerIds(current =>
        equalStringArrays(current, nextActiveMarkerIds) ? current : nextActiveMarkerIds
      )
    },
    [scrollRef]
  )

  const calculateMarkers = useCallback(
    (reason: string) => {
      const scroller = scrollRef.current
      const content = contentRef.current
      const userTurns = buildUserTurnsForNavigation(messagesRef.current, turnNavigationRef.current)
      if (!scroller || !content || userTurns.length < 2) {
        markersRef.current = []
        measuredScrollGeometryRef.current = null
        setMarkers([])
        setActiveMarkerIds([])
        return
      }

      const anchorByMessageId = getMessageAnchorById(content)
      const visibilityByTurnId = getTurnVisibilityBounds(
        userTurns,
        messagesRef.current,
        anchorByMessageId,
        scroller
      )
      const nextMarkers = userTurns.map(turn => {
        const anchor = anchorByMessageId.get(turn.id)
        const visibleBounds = visibilityByTurnId.get(turn.id)
        if (!anchor) {
          return {
            ...turn,
            loaded: false,
            targetTop: null,
            visibleTop: visibleBounds?.top ?? null,
            visibleBottom: visibleBounds?.bottom ?? null,
          }
        }

        const anchorRect = anchor.getBoundingClientRect()
        const targetTop = getContentPositionForViewportY(scroller, anchorRect.top)
        return {
          ...turn,
          loaded: true,
          targetTop,
          visibleTop: visibleBounds?.top ?? targetTop,
          visibleBottom:
            visibleBounds?.bottom ?? getContentPositionForViewportY(scroller, anchorRect.bottom),
        }
      })

      markersRef.current = nextMarkers
      measuredScrollGeometryRef.current = {
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      }
      setMarkers(nextMarkers)
      updateActiveMarkers(nextMarkers, reason)
    },
    [contentRef, scrollRef, updateActiveMarkers]
  )

  const scheduleCalculateMarkers = useCallback(
    (reason: string) => {
      if (timerRef.current !== null) return

      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        calculateMarkers(reason)
      }, 0)
    },
    [calculateMarkers]
  )

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller && contentRef.current) {
      calculateMarkers('messages-layout-effect')
      return
    }
    scheduleCalculateMarkers('messages-effect')
  }, [calculateMarkers, contentRef, scheduleCalculateMarkers, scrollRef, userTurnsSignature])

  useLayoutEffect(() => {
    if (!pendingScrollTarget) return

    const scroller = scrollRef.current
    const targetMessageId = findLoadedNavigationMessageId(messages, pendingScrollTarget)
    const anchor = targetMessageId ? findMessageAnchor(contentRef, targetMessageId) : null
    if (!scroller || !targetMessageId) return
    onNavigationScrollTargetChange?.(targetMessageId)
    if (!anchor) return

    scrollToMessageId(scroller, targetMessageId)
    setLoadingMarkerId(current => (current === pendingScrollTarget.navigationId ? null : current))
    setPendingScrollTarget(null)
    onNavigationLoadStateChange?.(false)
  }, [
    contentRef,
    markers,
    messages,
    onNavigationLoadStateChange,
    onNavigationScrollTargetChange,
    pendingScrollTarget,
    scrollRef,
    scrollToMessageId,
  ])

  useEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return

    // Mounted anchors are recalculated by observers; raw scroll events reuse
    // their measured bounds to update which conversation turns intersect the viewport.
    const handleScroll = () => {
      const measuredGeometry = measuredScrollGeometryRef.current
      if (
        measuredGeometry &&
        (scroller.scrollHeight !== measuredGeometry.scrollHeight ||
          scroller.clientHeight !== measuredGeometry.clientHeight)
      ) {
        scheduleCalculateMarkers('scroll-layout-changed')
        return
      }
      updateActiveMarkers(markersRef.current, 'scroll')
    }
    const handleResize = () => scheduleCalculateMarkers('window-resize')
    scroller.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleResize)

    const mutationObserver = new MutationObserver(() => scheduleCalculateMarkers('mutation'))
    mutationObserver.observe(content, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      subtree: true,
    })

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => scheduleCalculateMarkers('resize-observer'))
    resizeObserver?.observe(content)
    resizeObserver?.observe(scroller)

    return () => {
      scroller.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleResize)
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [contentRef, scheduleCalculateMarkers, scrollRef, updateActiveMarkers])

  const handleMarkerClick = useCallback(
    async (marker: MessageTurnMarker) => {
      cancelNavigation()
      const owner = {}
      loadOwnerRef.current = owner
      const scroller = scrollRef.current
      if (!scroller) {
        loadOwnerRef.current = null
        return
      }
      const activeMarkerId = activeMarkerIds[0] ?? null

      const currentAnchor = findMessageAnchor(contentRef, marker.id)
      logTurnNavigation('marker-click', {
        markerId: marker.id,
        turnIndex: marker.turnIndex,
        messageIndex: marker.messageIndex,
        markerLoaded: marker.loaded,
        anchorFound: Boolean(currentAnchor),
        markerTargetTop: marker.targetTop,
        activeMarkerId,
        ...getScrollMetrics(scroller, currentAnchor),
      })
      if (currentAnchor) {
        const gapMarker = findUnloadedMarkerBetween(markersRef.current, activeMarkerId, marker.id)
        if (gapMarker && onLoadTurnNavigationItem) {
          setLoadingMarkerId(gapMarker.id)
          onNavigationLoadStateChange?.(true)
          try {
            await onLoadTurnNavigationItem(gapMarker)
          } catch (error) {
            console.error('[Wework] Message turn navigation gap load failed', {
              targetMarkerId: marker.id,
              gapMarkerId: gapMarker.id,
              error,
            })
          } finally {
            if (loadOwnerRef.current === owner) {
              setLoadingMarkerId(current => (current === gapMarker.id ? null : current))
              onNavigationLoadStateChange?.(false)
            }
          }
        }
        if (loadOwnerRef.current === owner) scrollToMessageId(scroller, marker.id, 'smooth')
        return
      }

      const loadedMessageId = findLoadedNavigationMessageId(messages, {
        navigationId: marker.id,
        userMessageId: marker.userMessageId,
        turnId: marker.turnId,
        messageIndex: marker.messageIndex,
      })
      if (loadedMessageId) {
        setPendingScrollTarget({
          navigationId: marker.id,
          userMessageId: marker.userMessageId,
          turnId: marker.turnId,
          messageIndex: marker.messageIndex,
        })
        setLoadingMarkerId(marker.id)
        onNavigationLoadStateChange?.(true)
        onNavigationScrollTargetChange?.(loadedMessageId)
        return
      }

      if (!marker.cursor || !onLoadTurnNavigationItem) {
        loadOwnerRef.current = null
        return
      }
      setPendingScrollTarget({
        navigationId: marker.id,
        userMessageId: marker.userMessageId,
        turnId: marker.turnId,
        messageIndex: marker.messageIndex,
      })
      setLoadingMarkerId(marker.id)
      onNavigationLoadStateChange?.(true)
      try {
        await onLoadTurnNavigationItem(marker)
      } catch (error) {
        if (loadOwnerRef.current !== owner) return
        loadOwnerRef.current = null
        setPendingScrollTarget(current => (current?.navigationId === marker.id ? null : current))
        setLoadingMarkerId(current => (current === marker.id ? null : current))
        onNavigationLoadStateChange?.(false)
        console.error('[Wework] Message turn navigation marker load failed', {
          markerId: marker.id,
          error,
        })
      }
    },
    [
      activeMarkerIds,
      cancelNavigation,
      contentRef,
      messages,
      onLoadTurnNavigationItem,
      onNavigationLoadStateChange,
      onNavigationScrollTargetChange,
      scrollRef,
      scrollToMessageId,
    ]
  )

  useEffect(
    () => () => {
      clearNavigationPosition()
      onNavigationScrollTargetChange?.(null)
    },
    [clearNavigationPosition, onNavigationScrollTargetChange]
  )

  if (markers.length === 0) return null

  const navigationHeight = getNavigationHeight(markers.length)
  const hoveredMarkerIndex =
    hoveredMarkerId === null ? -1 : markers.findIndex(marker => marker.id === hoveredMarkerId)

  const navigation = (
    <nav
      aria-label={t('conversation.message_navigation.label', '历史发言导航')}
      {...portalTheme}
      className={cn(
        portalTheme.className,
        'pointer-events-none absolute top-1/2 z-popover hidden -translate-y-1/2 lg:block'
      )}
      data-testid="message-turn-navigation"
      style={{
        ...portalTheme.style,
        left: '16px',
        width: `${MARKER_HIT_AREA_WIDTH_PX}px`,
        height: `${navigationHeight}px`,
        maxHeight: `calc(100% - ${NAVIGATION_VIEWPORT_PADDING_PX}px)`,
      }}
    >
      <div
        className="pointer-events-auto h-full w-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid="message-turn-navigation-rail"
        style={{
          overflowY: 'auto',
          overscrollBehaviorY: 'contain',
        }}
        onScroll={event => setNavigationScrollTop(event.currentTarget.scrollTop)}
      >
        <div className="relative w-full" style={{ height: `${navigationHeight}px` }}>
          {markers.map((marker, index) => {
            const isActive = activeMarkerIds.includes(marker.id)
            const isLoading = loadingMarkerId === marker.id
            const hoverDistance =
              hoveredMarkerIndex === -1 ? null : Math.abs(index - hoveredMarkerIndex)

            return (
              <div
                key={marker.id}
                className="absolute left-0 -translate-y-1/2"
                style={{
                  top: `${getMarkerTopPx(index)}px`,
                  height: `${MARKER_HOVER_ROW_HEIGHT_PX}px`,
                  width: `${MARKER_HIT_AREA_WIDTH_PX}px`,
                }}
                onMouseEnter={() => setHoveredMarkerId(marker.id)}
                onMouseLeave={() => setHoveredMarkerId(null)}
              >
                <button
                  type="button"
                  aria-label={t('conversation.message_navigation.jump_to_message', undefined, {
                    index: marker.turnIndex + 1,
                    defaultValue: `跳转到第 ${marker.turnIndex + 1} 条发言`,
                  })}
                  aria-busy={isLoading}
                  className={cn(
                    'pointer-events-auto flex h-full w-full items-center justify-start rounded-md p-0 focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary/35',
                    isLoading && 'cursor-progress'
                  )}
                  data-active={isActive}
                  data-turn-index={marker.turnIndex}
                  data-testid="message-turn-navigation-marker"
                  onClick={() => handleMarkerClick(marker)}
                  onFocus={() => setHoveredMarkerId(marker.id)}
                  onBlur={() => setHoveredMarkerId(null)}
                >
                  <span
                    className={cn(
                      'block h-[2px] rounded-full transition-all duration-150 ease-out',
                      getMarkerToneClass(isActive, hoverDistance, marker.loaded, isLoading)
                    )}
                    style={{
                      width: `${getMarkerWidthPx(hoverDistance, isLoading)}px`,
                    }}
                  />
                </button>
              </div>
            )
          })}
        </div>
      </div>
      {markers.map((marker, index) => (
        <div
          key={`${marker.id}-preview`}
          className={cn(
            'pointer-events-none absolute left-8 z-30 w-[300px] max-w-[calc(100vw-56px)] -translate-y-1/2 rounded-md border border-border bg-background px-2.5 py-2 text-left shadow-[0_10px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150',
            hoveredMarkerId === marker.id ? 'opacity-100' : 'opacity-0'
          )}
          data-testid="message-turn-navigation-preview"
          data-turn-index={marker.turnIndex}
          style={{ top: `${getMarkerTopPx(index) - navigationScrollTop}px` }}
        >
          <p className="break-words text-xs font-semibold leading-4 text-text-primary">
            {marker.promptPreview}
          </p>
          {marker.responsePreview && (
            <p className="mt-1 break-words text-xs leading-4 text-text-muted">
              {marker.responsePreview}
            </p>
          )}
        </div>
      ))}
    </nav>
  )

  return portalTarget ? createPortal(navigation, portalTarget) : navigation
}
