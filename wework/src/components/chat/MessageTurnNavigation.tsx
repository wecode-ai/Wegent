import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
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
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
}

interface UserTurn {
  id: string
  turnIndex: number
  messageIndex: number
  promptPreview: string
  responsePreview: string
}

interface MessageTurnMarker extends UserTurn {
  targetTop: number
}

export function MessageTurnNavigation({
  messages,
  scrollRef,
  contentRef,
}: MessageTurnNavigationProps) {
  const { t } = useTranslation('chat')
  const [markers, setMarkers] = useState<MessageTurnMarker[]>([])
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null)
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  const [navigationScrollTop, setNavigationScrollTop] = useState(0)
  const markersRef = useRef<MessageTurnMarker[]>([])
  const rafRef = useRef<number | null>(null)

  const userTurns = useMemo(() => buildUserTurns(messages), [messages])

  const updateActiveMarker = useCallback(
    (nextMarkers: MessageTurnMarker[]) => {
      const scroller = scrollRef.current
      if (!scroller || nextMarkers.length === 0) {
        setActiveMarkerId(null)
        return
      }

      const currentPosition = scroller.scrollTop + SCROLL_OFFSET_PX
      let activeMarker = nextMarkers[0]
      for (const marker of nextMarkers) {
        if (marker.targetTop <= currentPosition) {
          activeMarker = marker
        } else {
          break
        }
      }

      setActiveMarkerId(activeMarker.id)
    },
    [scrollRef]
  )

  const calculateMarkers = useCallback(() => {
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
    const nextMarkers = userTurns.flatMap(turn => {
      const anchor = findMessageAnchorById(content, turn.id)
      if (!anchor) return []

      const anchorRect = anchor.getBoundingClientRect()
      const targetTop = Math.max(0, scroller.scrollTop + anchorRect.top - scrollerRect.top)
      return [
        {
          ...turn,
          targetTop,
        },
      ]
    })

    markersRef.current = nextMarkers
    setMarkers(nextMarkers)
    updateActiveMarker(nextMarkers)
  }, [contentRef, scrollRef, updateActiveMarker, userTurns])

  const scheduleCalculateMarkers = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
    }

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      calculateMarkers()
    })
  }, [calculateMarkers])

  useLayoutEffect(() => {
    calculateMarkers()
  }, [calculateMarkers])

  useEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return

    const handleScroll = () => updateActiveMarker(markersRef.current)
    scroller.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', scheduleCalculateMarkers)

    const mutationObserver = new MutationObserver(scheduleCalculateMarkers)
    mutationObserver.observe(content, { childList: true, subtree: true })

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleCalculateMarkers)
    resizeObserver?.observe(content)
    resizeObserver?.observe(scroller)

    return () => {
      scroller.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', scheduleCalculateMarkers)
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [contentRef, scheduleCalculateMarkers, scrollRef, updateActiveMarker])

  const handleMarkerClick = useCallback(
    (marker: MessageTurnMarker) => {
      const scroller = scrollRef.current
      if (!scroller) return

      scroller.scrollTo({
        top: Math.max(0, marker.targetTop - SCROLL_OFFSET_PX),
        behavior: 'smooth',
      })
    },
    [scrollRef]
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
                  className="pointer-events-auto flex h-full w-full items-center justify-start rounded-md p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
                  data-active={isActive}
                  data-testid="message-turn-navigation-marker"
                  onClick={() => handleMarkerClick(marker)}
                  onFocus={() => setHoveredMarkerId(marker.id)}
                  onBlur={() => setHoveredMarkerId(null)}
                >
                  <span
                    className={cn(
                      'block h-[2px] rounded-full transition-all duration-150 ease-out',
                      getMarkerToneClass(isActive, hoverDistance)
                    )}
                    style={{
                      width: `${getMarkerWidthPx(hoverDistance)}px`,
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
  messages.forEach((message, index) => {
    if (message.role !== 'user') return

    turns.push({
      id: message.id,
      turnIndex: turns.length,
      messageIndex: index,
      promptPreview: getUserPromptPreview(message),
      responsePreview: getFollowingAssistantPreview(messages, index),
    })
  })

  return turns
}

function getUserPromptPreview(message: WorkbenchMessage) {
  const codexRequest = extractCodexRequest(message.content)
  return truncatePreview(codexRequest || message.content, USER_PREVIEW_LENGTH)
}

function getFollowingAssistantPreview(messages: WorkbenchMessage[], userMessageIndex: number) {
  const assistantMessage = messages
    .slice(userMessageIndex + 1)
    .find(message => message.role === 'assistant')
  if (!assistantMessage) return ''

  const textBlockContent = getFirstTextBlockContent(assistantMessage)
  const previewSource = assistantMessage.content.trim() || textBlockContent
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

function getMarkerWidthPx(hoverDistance: number | null) {
  if (hoverDistance === 0) return EXPANDED_MARKER_WIDTH_PX
  if (hoverDistance === 1) return NEARBY_MARKER_WIDTH_PX
  if (hoverDistance === 2) return SECONDARY_MARKER_WIDTH_PX

  return COLLAPSED_MARKER_WIDTH_PX
}

function getMarkerToneClass(isActive: boolean, hoverDistance: number | null) {
  if (hoverDistance === 0) return 'bg-text-primary opacity-100'
  if (hoverDistance === 1) return 'bg-text-primary/70 opacity-90'
  if (hoverDistance === 2) return 'bg-text-muted/75 opacity-80'
  if (hoverDistance !== null) return 'bg-text-muted/55 opacity-70'
  if (isActive) return 'bg-text-primary opacity-100'

  return 'bg-text-muted/55 opacity-70'
}

function findMessageAnchorById(content: HTMLElement, messageId: string) {
  return (
    Array.from(content.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR)).find(
      anchor => anchor.dataset.messageId === messageId
    ) ?? null
  )
}
