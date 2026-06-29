import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { RuntimeTurnNavigationItem } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'

const USER_PREVIEW_LENGTH = 56
const RESPONSE_PREVIEW_LENGTH = 72
const SCROLL_OFFSET_PX = 96
const COLLAPSED_MARKER_WIDTH_PX = 8
const SECONDARY_MARKER_WIDTH_PX = 12
const NEARBY_MARKER_WIDTH_PX = 16
const EXPANDED_MARKER_WIDTH_PX = 24
const MARKER_HIT_AREA_WIDTH_PX = 28
const MARKER_ROW_HEIGHT_PX = 8
const MARKER_ROW_GAP_PX = 20 / 9
const MARKER_HOVER_ROW_HEIGHT_PX = MARKER_ROW_HEIGHT_PX + MARKER_ROW_GAP_PX
const NAVIGATION_VIEWPORT_PADDING_PX = 48
const MESSAGE_ANCHOR_SELECTOR = '[data-message-id]'
const CODEX_REQUEST_MARKER_PATTERN = /^## My request for Codex:\s*$/im

interface MessageTurnNavigationProps {
  messages: WorkbenchMessage[]
  turnNavigation?: RuntimeTurnNavigationItem[]
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onLoadTurnNavigationItem?: (item: RuntimeTurnNavigationItem) => Promise<void> | void
  onNavigationLoadStateChange?: (loading: boolean) => void
}

interface UserTurn {
  id: string
  turnIndex: number
  messageIndex: number
  promptPreview: string
  responsePreview: string
  cursor?: string | null
  loaded: boolean
}

interface MessageTurnMarker extends UserTurn {
  targetTop: number | null
}

export function MessageTurnNavigation({
  messages,
  turnNavigation,
  scrollRef,
  contentRef,
  onLoadTurnNavigationItem,
  onNavigationLoadStateChange,
}: MessageTurnNavigationProps) {
  const { t } = useTranslation('chat')
  const [markers, setMarkers] = useState<MessageTurnMarker[]>([])
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null)
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  const [loadingMarkerId, setLoadingMarkerId] = useState<string | null>(null)
  const [pendingScrollTargetId, setPendingScrollTargetId] = useState<string | null>(null)
  const [navigationScrollTop, setNavigationScrollTop] = useState(0)
  const markersRef = useRef<MessageTurnMarker[]>([])
  const rafRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)

  const userTurns = useMemo(() => {
    return turnNavigation && turnNavigation.length > 0
      ? buildUserTurnsFromNavigation(turnNavigation, messages)
      : buildUserTurns(messages)
  }, [messages, turnNavigation])

  const updateActiveMarker = useCallback(
    (nextMarkers: MessageTurnMarker[], reason = 'unknown') => {
      void reason
      const scroller = scrollRef.current
      if (!scroller || nextMarkers.length === 0) {
        setActiveMarkerId(null)
        return
      }

      const currentPosition = scroller.scrollTop + SCROLL_OFFSET_PX
      const loadedMarkers = nextMarkers.filter(marker => marker.targetTop !== null)
      if (loadedMarkers.length === 0) {
        setActiveMarkerId(null)
        return
      }

      let activeMarker = loadedMarkers[0]
      for (const marker of loadedMarkers) {
        if (marker.targetTop !== null && marker.targetTop <= currentPosition) {
          activeMarker = marker
        } else {
          break
        }
      }

      setActiveMarkerId(activeMarker.id)
    },
    [scrollRef]
  )

  const calculateMarkers = useCallback(
    (reason: string) => {
      const scroller = scrollRef.current
      const content = contentRef.current
      if (!scroller || !content || userTurns.length === 0) {
        markersRef.current = []
        setMarkers([])
        setActiveMarkerId(null)
        return
      }

      if (scroller.scrollHeight <= scroller.clientHeight + 8) {
        markersRef.current = []
        setMarkers([])
        setActiveMarkerId(null)
        return
      }

      const scrollerRect = scroller.getBoundingClientRect()
      const anchorByMessageId = getMessageAnchorById(content)
      const nextMarkers = userTurns.map(turn => {
        const anchor = anchorByMessageId.get(turn.id)
        if (!anchor) {
          return {
            ...turn,
            loaded: false,
            targetTop: null,
          }
        }

        const anchorRect = anchor.getBoundingClientRect()
        const targetTop = Math.max(0, scroller.scrollTop + anchorRect.top - scrollerRect.top)
        return {
          ...turn,
          loaded: true,
          targetTop,
        }
      })

      markersRef.current = nextMarkers
      setMarkers(nextMarkers)
      updateActiveMarker(nextMarkers, reason)
    },
    [contentRef, scrollRef, updateActiveMarker, userTurns]
  )

  const scheduleCalculateMarkers = useCallback(
    (reason: string) => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }

      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          calculateMarkers(reason)
        }, 0)
      })
    },
    [calculateMarkers]
  )

  useEffect(() => {
    scheduleCalculateMarkers('messages-effect')
  }, [scheduleCalculateMarkers])

  useLayoutEffect(() => {
    if (!pendingScrollTargetId) return

    const scroller = scrollRef.current
    const anchor = findMessageAnchor(contentRef, pendingScrollTargetId)
    if (!scroller || !anchor) return

    scrollToMessageAnchor(scroller, anchor)
    setActiveMarkerId(pendingScrollTargetId)
    setLoadingMarkerId(current => (current === pendingScrollTargetId ? null : current))
    setPendingScrollTargetId(null)
    finishNavigationLoad(onNavigationLoadStateChange)
  }, [contentRef, onNavigationLoadStateChange, pendingScrollTargetId, scrollRef])

  useEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return

    const handleScroll = () => updateActiveMarker(markersRef.current, 'scroll')
    const handleResize = () => scheduleCalculateMarkers('window-resize')
    scroller.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleResize)

    const mutationObserver = new MutationObserver(() => scheduleCalculateMarkers('mutation'))
    mutationObserver.observe(content, { childList: true })

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => scheduleCalculateMarkers('resize-observer'))
    resizeObserver?.observe(content)

    return () => {
      scroller.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleResize)
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [contentRef, scheduleCalculateMarkers, scrollRef, updateActiveMarker])

  const handleMarkerClick = useCallback(
    async (marker: MessageTurnMarker) => {
      const scroller = scrollRef.current
      if (!scroller) return

      const currentAnchor = findMessageAnchor(contentRef, marker.id)
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
            setLoadingMarkerId(current => (current === gapMarker.id ? null : current))
            finishNavigationLoad(onNavigationLoadStateChange)
          }
        }
        scrollToMessageAnchor(scroller, currentAnchor, 'smooth')
        setActiveMarkerId(marker.id)
        return
      }

      if (!marker.cursor || !onLoadTurnNavigationItem) {
        return
      }
      setPendingScrollTargetId(marker.id)
      setLoadingMarkerId(marker.id)
      onNavigationLoadStateChange?.(true)
      try {
        await onLoadTurnNavigationItem(marker)
      } catch (error) {
        setPendingScrollTargetId(current => (current === marker.id ? null : current))
        setLoadingMarkerId(current => (current === marker.id ? null : current))
        onNavigationLoadStateChange?.(false)
        console.error('[Wework] Message turn navigation marker load failed', {
          markerId: marker.id,
          error,
        })
      }
    },
    [activeMarkerId, contentRef, onLoadTurnNavigationItem, onNavigationLoadStateChange, scrollRef]
  )

  if (markers.length === 0) return null

  const navigationHeight = getNavigationHeight(markers.length)
  const hoveredMarkerIndex =
    hoveredMarkerId === null ? -1 : markers.findIndex(marker => marker.id === hoveredMarkerId)

  return (
    <nav
      aria-label={t('message_navigation.label', '历史发言导航')}
      className="pointer-events-none absolute top-1/2 z-popover hidden -translate-y-1/2 lg:block"
      data-testid="message-turn-navigation"
      style={{
        left: '8px',
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
            const isActive = activeMarkerId === marker.id
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
                  aria-label={t('message_navigation.jump_to_message', {
                    index: marker.turnIndex + 1,
                    defaultValue: `跳转到第 ${marker.turnIndex + 1} 条发言`,
                  })}
                  aria-busy={isLoading}
                  className={cn(
                    'pointer-events-auto flex h-full w-full items-center justify-start rounded-md p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35',
                    isLoading && 'cursor-progress'
                  )}
                  data-active={isActive}
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
          style={{ top: `${getMarkerTopPx(index) - navigationScrollTop}px` }}
        >
          <p className="break-words text-[11px] font-semibold leading-4 text-text-primary">
            {marker.promptPreview}
          </p>
          {marker.responsePreview && (
            <p className="mt-1 break-words text-[11px] leading-4 text-text-muted">
              {marker.responsePreview}
            </p>
          )}
        </div>
      ))}
    </nav>
  )
}

function buildUserTurns(messages: WorkbenchMessage[]): UserTurn[] {
  const turns: UserTurn[] = []
  const pendingResponsePreviewTurnIndexes: number[] = []
  messages.forEach((message, index) => {
    if (message.role !== 'user') {
      if (message.role === 'assistant' && pendingResponsePreviewTurnIndexes.length > 0) {
        const responsePreview = getAssistantPreview(message)
        pendingResponsePreviewTurnIndexes.forEach(turnIndex => {
          turns[turnIndex].responsePreview = responsePreview
        })
        pendingResponsePreviewTurnIndexes.length = 0
      }
      return
    }

    turns.push({
      id: message.id,
      turnIndex: turns.length,
      messageIndex: index,
      promptPreview: getUserPromptPreview(message),
      responsePreview: '',
      cursor: `offset:${index}`,
      loaded: true,
    })
    pendingResponsePreviewTurnIndexes.push(turns.length - 1)
  })

  return turns
}

function buildUserTurnsFromNavigation(
  navigation: RuntimeTurnNavigationItem[],
  messages: WorkbenchMessage[]
): UserTurn[] {
  const loadedMessageIds = new Set(messages.map(message => message.id))
  return navigation.map((item, index) => ({
    id: item.id,
    turnIndex: typeof item.turnIndex === 'number' ? item.turnIndex : index,
    messageIndex: item.messageIndex,
    promptPreview: item.promptPreview,
    responsePreview: item.responsePreview ?? '',
    cursor: item.cursor ?? `offset:${item.messageIndex}`,
    loaded: loadedMessageIds.has(item.id),
  }))
}

function getUserPromptPreview(message: WorkbenchMessage) {
  const codexRequest = extractCodexRequest(message.content)
  return truncatePreview(codexRequest || message.content, USER_PREVIEW_LENGTH)
}

function getAssistantPreview(message: WorkbenchMessage) {
  const textBlockContent = getFirstTextBlockContent(message)
  const previewSource = message.content.trim() || textBlockContent
  return truncatePreview(previewSource, RESPONSE_PREVIEW_LENGTH)
}

function getFirstTextBlockContent(message: WorkbenchMessage) {
  for (const block of message.blocks ?? []) {
    if (block.type !== 'text' || !('content' in block) || typeof block.content !== 'string') {
      continue
    }

    if (block.content.trim()) {
      return block.content
    }
  }

  return ''
}

function extractCodexRequest(content: string) {
  const requestMarker = content.match(CODEX_REQUEST_MARKER_PATTERN)
  if (requestMarker?.index === undefined) return ''

  return content.slice(requestMarker.index + requestMarker[0].length).trim()
}

function truncatePreview(text: string, maxLength: number) {
  const normalizedText = text.replace(/\s+/g, ' ').trim()
  if (normalizedText.length <= maxLength) return normalizedText

  return `${normalizedText.slice(0, maxLength)}...`
}

function getNavigationHeight(markerCount: number) {
  if (markerCount <= 1) return MARKER_ROW_HEIGHT_PX

  return MARKER_ROW_HEIGHT_PX + (markerCount - 1) * (MARKER_ROW_HEIGHT_PX + MARKER_ROW_GAP_PX)
}

function getMarkerTopPx(index: number) {
  return MARKER_ROW_HEIGHT_PX / 2 + index * (MARKER_ROW_HEIGHT_PX + MARKER_ROW_GAP_PX)
}

function getMarkerWidthPx(hoverDistance: number | null, loading = false) {
  if (loading) return EXPANDED_MARKER_WIDTH_PX
  if (hoverDistance === 0) return EXPANDED_MARKER_WIDTH_PX
  if (hoverDistance === 1) return NEARBY_MARKER_WIDTH_PX
  if (hoverDistance === 2) return SECONDARY_MARKER_WIDTH_PX

  return COLLAPSED_MARKER_WIDTH_PX
}

function findUnloadedMarkerBetween(
  markers: MessageTurnMarker[],
  activeMarkerId: string | null,
  targetMarkerId: string
): MessageTurnMarker | null {
  if (!activeMarkerId || activeMarkerId === targetMarkerId) return null

  const activeIndex = markers.findIndex(marker => marker.id === activeMarkerId)
  const targetIndex = markers.findIndex(marker => marker.id === targetMarkerId)
  if (activeIndex === -1 || targetIndex === -1) return null

  const start = Math.min(activeIndex, targetIndex) + 1
  const end = Math.max(activeIndex, targetIndex)
  const candidates = markers.slice(start, end).filter(marker => !marker.loaded)
  if (candidates.length === 0) return null

  return targetIndex > activeIndex ? candidates[0] : candidates[candidates.length - 1]
}

function getMarkerToneClass(
  isActive: boolean,
  hoverDistance: number | null,
  loaded: boolean,
  loading = false
) {
  if (loading) return 'animate-pulse bg-primary opacity-100'
  if (hoverDistance === 0) return 'bg-text-primary opacity-100'
  if (hoverDistance === 1) return 'bg-text-primary/70 opacity-90'
  if (hoverDistance === 2) return 'bg-text-muted/75 opacity-80'
  if (hoverDistance !== null) return 'bg-text-muted/55 opacity-70'
  if (isActive) return 'bg-text-primary opacity-100'
  if (!loaded) return 'bg-text-muted/35 opacity-60'

  return 'bg-text-muted/55 opacity-70'
}

function scrollToMarkerTarget(
  scroller: HTMLDivElement,
  targetTop: number,
  behavior: ScrollBehavior
) {
  const top = Math.max(0, targetTop - SCROLL_OFFSET_PX)
  if (behavior === 'auto') {
    scroller.scrollTop = top
    return
  }

  scroller.scrollTo({
    top,
    behavior,
  })
}

function scrollToMessageAnchor(
  scroller: HTMLDivElement,
  anchor: HTMLElement,
  behavior: ScrollBehavior = 'auto'
) {
  if (behavior === 'smooth') {
    scrollToMarkerTarget(scroller, getMessageAnchorTargetTop(scroller, anchor), behavior)
    return
  }

  if (typeof anchor.scrollIntoView === 'function') {
    anchor.scrollIntoView({
      block: 'start',
      inline: 'nearest',
      behavior,
    })
    scroller.scrollTop = Math.max(0, scroller.scrollTop - SCROLL_OFFSET_PX)
    return
  }

  scrollToMarkerTarget(scroller, getMessageAnchorTargetTop(scroller, anchor), 'auto')
}

function findMessageAnchor(
  contentRef: RefObject<HTMLDivElement | null>,
  messageId: string
): HTMLElement | null {
  const content = contentRef.current
  return content ? (getMessageAnchorById(content).get(messageId) ?? null) : null
}

function getMessageAnchorTargetTop(scroller: HTMLDivElement, anchor: HTMLElement) {
  const scrollerRect = scroller.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  return Math.max(0, scroller.scrollTop + anchorRect.top - scrollerRect.top)
}

function getMessageAnchorById(content: HTMLElement) {
  const anchors = new Map<string, HTMLElement>()
  content.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR).forEach(anchor => {
    const messageId = anchor.dataset.messageId
    if (messageId) {
      anchors.set(messageId, anchor)
    }
  })
  return anchors
}

function finishNavigationLoad(onNavigationLoadStateChange?: (loading: boolean) => void) {
  if (!onNavigationLoadStateChange) return

  if (typeof queueMicrotask === 'function') {
    queueMicrotask(() => onNavigationLoadStateChange(false))
    return
  }

  void Promise.resolve().then(() => onNavigationLoadStateChange(false))
}
