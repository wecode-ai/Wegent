import { Button as ControlButton } from '../markdown/Button'
import { useWindowEvent } from '../dom-events'
import { createTurnNavigationGeometrySource } from './turnNavigationGeometrySource'
import {
  requestSafeAnimationFrame,
  cancelSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from '../markdown/safeAnimationFrame'
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
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
  findMessageAnchor,
  findLoadedNavigationMessageId,
  getMessageAnchorTargetTop,
  getScrollMetrics,
  logTurnNavigation,
} from './turnNavigationUtils'
import type {
  MessageTurnNavigationProps,
  MessageTurnMarker,
  PendingScrollTarget,
  UserTurn,
} from './turnNavigationTypes'
import { isConversationScrollInput, scrollToContentPosition } from './conversationViewportScroll'
import { getClampedPreviewTopPx } from './turnNavigationGeometry'

interface PreviewClampMeasurement {
  markerId: string
  previewHeightPx: number
  regionTopPx: number
  regionBottomPx: number
}

export function MessageTurnNavigation(props: MessageTurnNavigationProps) {
  const userTurns = buildUserTurnsForNavigation(props.messages, props.turnNavigation)
  if (userTurns.length < 2 && !props.messageTarget) return null
  return <ConversationTurnNavigation {...props} userTurns={userTurns} />
}

function ConversationTurnNavigation({
  messageTarget,
  translate: t,
  messages,
  userTurns,
  scrollRef,
  interactionRef,
  contentRef,
  onLoadTurnNavigationItem,
  onNavigationLoadStateChange,
  onNavigationScrollTargetChange,
  portalTarget,
  bottomInsetPx = 0,
}: MessageTurnNavigationProps & { userTurns: UserTurn[] }) {
  const portalTheme = useCollaborationPortalTheme()
  const insetPx = Math.max(0, Math.round(bottomInsetPx))
  const locatedRequest = useRef<string | null>(null)
  const locatingRequest = useRef<string | null>(null)
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  const [loadingMarkerId, setLoadingMarkerId] = useState<string | null>(null)
  const [pendingScrollTarget, setPendingScrollTarget] = useState<PendingScrollTarget | null>(null)
  const [navigationScrollTop, setNavigationScrollTop] = useState(0)
  const [previewClamp, setPreviewClamp] = useState<PreviewClampMeasurement | null>(null)
  const navRef = useRef<HTMLElement | null>(null)
  const previewNodesRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const navigationCleanupRef = useRef<(() => void) | null>(null)
  const openingTargetCleanupRef = useRef<(() => void) | null>(null)
  const messagesRef = useRef(messages)
  const userTurnsRef = useRef(userTurns)
  const [geometry] = useState(createTurnNavigationGeometrySource)
  const clearNavigationPosition = useCallback(() => {
    navigationCleanupRef.current?.()
    navigationCleanupRef.current = null
  }, [])

  const cancelNavigation = useCallback(() => {
    openingTargetCleanupRef.current?.()
    if (locatingRequest.current) locatedRequest.current = locatingRequest.current
    locatingRequest.current = null
    geometry.setLoadOwner(null)
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
    geometry,
    onNavigationLoadStateChange,
    onNavigationScrollTargetChange,
    scrollRef,
  ])

  // Refresh committed ports; the source retains observers while native nodes match.
  const subscribeGeometry = (listener: () => void) =>
    geometry.subscribe(listener, {
      scroll: scrollRef,
      content: contentRef,
      messages: messagesRef,
      turns: userTurnsRef,
      onLoadOwnerInvalidated(owner) {
        if (geometry.getLoadOwner() === owner) cancelNavigation()
      },
    })
  const { markers, activeMarkerIds } = useSyncExternalStore(
    subscribeGeometry,
    geometry.getSnapshot,
    geometry.getSnapshot
  )

  const cancelForInput = (event: Event) => {
    const path = event.composedPath()
    const target = event.target
    const inScope = [scrollRef.current, interactionRef?.current].some(
      node => node && (path.includes(node) || (target instanceof Node && node.contains(target)))
    )
    if (
      !inScope ||
      (!geometry.getLoadOwner() &&
        !navigationCleanupRef.current &&
        !openingTargetCleanupRef.current) ||
      !isConversationScrollInput(event)
    )
      return
    cancelNavigation()
  }
  useWindowEvent('wheel', cancelForInput, { capture: true, passive: true })
  useWindowEvent('pointerdown', cancelForInput, { capture: true, passive: true })
  useWindowEvent('touchstart', cancelForInput, { capture: true, passive: true })
  useWindowEvent('keydown', cancelForInput, { capture: true, passive: true })
  useWindowEvent(
    'scroll',
    event => {
      if (event.target === scrollRef.current) geometry.handleScroll()
    },
    { capture: true, passive: true }
  )
  useWindowEvent('resize', () => geometry.viewportChanged('window-resize'))

  const scrollToMessageId = useCallback(
    (
      scroller: HTMLDivElement,
      messageId: string,
      behavior: ScrollBehavior = 'auto',
      onLocated?: () => void
    ) => {
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
      geometry.setLoadOwner(null)
      onNavigationScrollTargetChange?.(messageId)
      logTurnNavigation('scroll-start', {
        messageId,
        behavior,
        ...getScrollMetrics(scroller, initialAnchor),
      })
      let targetTop = getMessageAnchorTargetTop(scroller, initialAnchor)
      scrollToContentPosition(scroller, targetTop, behavior)
      logTurnNavigation('scroll-initial-complete', {
        messageId,
        behavior,
        ...getScrollMetrics(scroller, initialAnchor),
      })

      let settled = false
      let frame: SafeAnimationFrameHandle | null = null
      const cleanup = () => {
        settled = true
        if (frame) cancelSafeAnimationFrame(frame)
        observer.disconnect()
        scroller.removeEventListener('scrollend', finish)
        if (navigationCleanupRef.current === cleanup) navigationCleanupRef.current = null
      }
      const finish = () => {
        if (settled) return
        const anchor = findMessageAnchor(contentRef, messageId)
        if (!anchor) return
        const measuredTargetTop = getMessageAnchorTargetTop(scroller, anchor)
        if (Math.abs(scroller.scrollTop - measuredTargetTop) >= 1) {
          targetTop = measuredTargetTop
          logTurnNavigation('scroll-retargeted', {
            messageId,
            targetTop,
            ...getScrollMetrics(scroller, anchor),
          })
          scrollToContentPosition(scroller, targetTop, 'auto')
          if (frame) cancelSafeAnimationFrame(frame)
          frame = requestSafeAnimationFrame(check)
          return
        }
        cleanup()
        logTurnNavigation('scroll-settled', {
          messageId,
          ...getScrollMetrics(scroller, anchor),
        })
        onLocated?.()
        onNavigationScrollTargetChange?.(null)
      }
      const check = () => {
        frame = null
        const anchor = findMessageAnchor(contentRef, messageId)
        if (!anchor || settled) return
        const target = getMessageAnchorTargetTop(scroller, anchor)
        if (Math.abs(scroller.scrollTop - target) < 1) finish()
      }
      const observer = new ResizeObserver(() => {
        const anchor = findMessageAnchor(contentRef, messageId)
        if (!anchor || settled) return
        const nextTargetTop = getMessageAnchorTargetTop(scroller, anchor)
        if (Math.abs(nextTargetTop - targetTop) < 1) return
        targetTop = nextTargetTop
        scrollToContentPosition(scroller, targetTop, 'auto')
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
    [clearNavigationPosition, contentRef, geometry, onNavigationScrollTargetChange]
  )

  const targetMessageId = messageTarget?.messageId
  const targetRequestKey = messageTarget?.requestKey
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroller = scrollRef.current
    if (!targetMessageId || !targetRequestKey || !content || !scroller) return
    const key = JSON.stringify([targetRequestKey, targetMessageId])
    if (locatedRequest.current === key) return
    clearNavigationPosition()
    locatingRequest.current = key
    const owner = {}
    geometry.setLoadOwner(owner, scrollRef.current, contentRef.current)
    let cancelled = false
    const cleanup = () => observer.disconnect()
    let ownedCleanup: (() => void) | null = cleanup
    const locate = () => {
      if (cancelled || !findMessageAnchor(contentRef, targetMessageId)) return
      locatingRequest.current = key
      scrollToMessageId(scroller, targetMessageId, 'auto', () => {
        if (locatingRequest.current !== key) return
        locatedRequest.current = key
        locatingRequest.current = null
      })
      ownedCleanup = navigationCleanupRef.current
    }
    const observer = new MutationObserver(locate)
    observer.observe(content, { childList: true, subtree: true })
    let width = scroller.clientWidth
    let height = scroller.clientHeight
    const viewportObserver = new ResizeObserver(() => {
      const nextWidth = scroller.clientWidth
      const nextHeight = scroller.clientHeight
      if (nextWidth === width && nextHeight === height) return
      width = nextWidth
      height = nextHeight
      // Opening a question owns its context until the reader chooses another position.
      if (!cancelled && locatedRequest.current === key) locate()
    })
    viewportObserver.observe(scroller)
    const cleanupOpeningTarget = () => {
      cancelled = true
      observer.disconnect()
      viewportObserver.disconnect()
      if (openingTargetCleanupRef.current === cleanupOpeningTarget)
        openingTargetCleanupRef.current = null
    }
    openingTargetCleanupRef.current = cleanupOpeningTarget
    navigationCleanupRef.current = cleanup
    onNavigationScrollTargetChange?.(targetMessageId)
    locate()
    return () => {
      cleanupOpeningTarget()
      if (ownedCleanup && navigationCleanupRef.current === ownedCleanup) {
        geometry.setLoadOwner(null)
        locatingRequest.current = null
        clearNavigationPosition()
        onNavigationScrollTargetChange?.(null)
      }
    }
  }, [
    targetMessageId,
    targetRequestKey,
    clearNavigationPosition,
    contentRef,
    geometry,
    onNavigationScrollTargetChange,
    scrollRef,
    scrollToMessageId,
  ])

  const userTurnsSignature = getUserTurnsSignature(userTurns)

  useLayoutEffect(() => {
    messagesRef.current = messages
    userTurnsRef.current = userTurns
  }, [messages, userTurns])

  useLayoutEffect(() => {
    if (!hoveredMarkerId) return
    const nav = navRef.current
    const preview = previewNodesRef.current.get(hoveredMarkerId)
    const parent = portalTarget ?? nav?.parentElement ?? null
    if (!nav || !preview || !parent) return

    const measure = () => {
      const navRect = nav.getBoundingClientRect()
      const parentRect = parent.getBoundingClientRect()
      const scrollerRect = scrollRef.current?.getBoundingClientRect() ?? null
      const regionTopViewportPx = Math.max(parentRect.top, scrollerRect?.top ?? parentRect.top)
      const regionBottomViewportPx =
        Math.min(parentRect.bottom, scrollerRect?.bottom ?? parentRect.bottom) - insetPx
      const next: PreviewClampMeasurement = {
        markerId: hoveredMarkerId,
        previewHeightPx: preview.getBoundingClientRect().height,
        regionTopPx: regionTopViewportPx - navRect.top,
        regionBottomPx: regionBottomViewportPx - navRect.top,
      }
      setPreviewClamp(current =>
        current &&
        current.markerId === next.markerId &&
        Math.abs(current.previewHeightPx - next.previewHeightPx) < 0.5 &&
        Math.abs(current.regionTopPx - next.regionTopPx) < 0.5 &&
        Math.abs(current.regionBottomPx - next.regionBottomPx) < 0.5
          ? current
          : next
      )
    }

    measure()
    window.addEventListener('resize', measure)
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(parent)
      observer.observe(preview)
      if (scrollRef.current) observer.observe(scrollRef.current)
    }
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [hoveredMarkerId, insetPx, portalTarget, scrollRef, userTurnsSignature])

  const calculateMarkers = geometry.calculate
  const scheduleCalculateMarkers = geometry.schedule

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

  const handleMarkerClick = useCallback(
    async (marker: MessageTurnMarker) => {
      cancelNavigation()
      const owner = {}
      geometry.setLoadOwner(owner, scrollRef.current, contentRef.current)
      const scroller = scrollRef.current
      if (!scroller) {
        geometry.setLoadOwner(null)
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
        const gapMarker = findUnloadedMarkerBetween(
          geometry.getSnapshot().markers,
          activeMarkerId,
          marker.id
        )
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
            if (geometry.isLoadOwnerCurrent(owner)) {
              setLoadingMarkerId(current => (current === gapMarker.id ? null : current))
              onNavigationLoadStateChange?.(false)
            }
          }
        }
        if (geometry.isLoadOwnerCurrent(owner)) scrollToMessageId(scroller, marker.id, 'smooth')
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
        geometry.setLoadOwner(null)
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
        if (!geometry.isLoadOwnerCurrent(owner)) return
        geometry.setLoadOwner(null)
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
      geometry,
      messages,
      onLoadTurnNavigationItem,
      onNavigationLoadStateChange,
      onNavigationScrollTargetChange,
      scrollRef,
      scrollToMessageId,
    ]
  )

  useLayoutEffect(
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
      ref={navRef}
      aria-label={t('conversation.message_navigation.label', '历史发言导航')}
      {...portalTheme}
      className={cn(
        portalTheme.className,
        'pointer-events-none absolute z-popover hidden -translate-y-1/2 lg:block'
      )}
      data-testid="message-turn-navigation"
      style={{
        ...portalTheme.style,
        left: '16px',
        top: insetPx === 0 ? '50%' : `calc(50% - ${insetPx / 2}px)`,
        width: `${MARKER_HIT_AREA_WIDTH_PX}px`,
        height: `${navigationHeight}px`,
        maxHeight:
          insetPx === 0
            ? `calc(100% - ${NAVIGATION_VIEWPORT_PADDING_PX}px)`
            : `calc(100% - ${NAVIGATION_VIEWPORT_PADDING_PX + insetPx}px)`,
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
                <ControlButton variant="unstyled"
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
                </ControlButton>
              </div>
            )
          })}
        </div>
      </div>
      {markers.map((marker, index) => {
        const previewTopPx = getMarkerTopPx(index) - navigationScrollTop
        const clampedPreviewTopPx =
          previewClamp?.markerId === marker.id
            ? getClampedPreviewTopPx({
                centerTopPx: previewTopPx,
                previewHeightPx: previewClamp.previewHeightPx,
                regionTopPx: previewClamp.regionTopPx,
                regionBottomPx: previewClamp.regionBottomPx,
              })
            : previewTopPx
        return (
          <div
            key={`${marker.id}-preview`}
            ref={node => {
              if (node) previewNodesRef.current.set(marker.id, node)
              else previewNodesRef.current.delete(marker.id)
            }}
            className={cn(
              'pointer-events-none absolute left-8 z-30 w-[300px] max-w-[calc(100vw-56px)] -translate-y-1/2 rounded-md border border-border bg-background px-2.5 py-2 text-left shadow-[0_10px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150',
              hoveredMarkerId === marker.id ? 'opacity-100' : 'opacity-0'
            )}
            data-testid="message-turn-navigation-preview"
            data-turn-index={marker.turnIndex}
            style={{ top: `${clampedPreviewTopPx}px` }}
          >
            <p className="break-words text-xs font-semibold leading-4 text-text-primary">
              {marker.promptPreview ||
                t('conversation.message_navigation.turn_label', undefined, {
                  index: marker.turnIndex + 1,
                  defaultValue: `第 ${marker.turnIndex + 1} 轮对话`,
                })}
            </p>
            {marker.responsePreview && (
              <p className="mt-1 break-words text-xs leading-4 text-text-muted">
                {marker.responsePreview}
              </p>
            )}
          </div>
        )
      })}
    </nav>
  )

  return portalTarget ? createPortal(navigation, portalTarget) : navigation
}
