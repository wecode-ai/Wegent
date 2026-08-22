import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

const DEFAULT_OPEN_DELAY_MS = 450
const CLOSE_DELAY_MS = 120
const CARD_GAP = 10
const VIEWPORT_PADDING = 8

interface HoverCardProps {
  children: ReactNode
  content: ReactNode
  testId: string
  interactive?: boolean
  openOnFocus?: boolean
  cardClassName?: string
  estimatedWidth?: number
  estimatedHeight?: number
}

interface HoverCardPosition {
  left: number
  top: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function hoverCardPosition(
  anchor: DOMRect,
  estimatedWidth: number,
  estimatedHeight: number
): HoverCardPosition {
  const availableRight = window.innerWidth - anchor.right - CARD_GAP
  const availableLeft = anchor.left - CARD_GAP
  const displayRight = availableRight >= estimatedWidth || availableRight >= availableLeft
  const desiredLeft = displayRight
    ? anchor.right + CARD_GAP
    : anchor.left - CARD_GAP - estimatedWidth
  const desiredTop =
    anchor.top + estimatedHeight + VIEWPORT_PADDING <= window.innerHeight
      ? anchor.top
      : anchor.bottom - estimatedHeight
  const maximumLeft = Math.max(
    VIEWPORT_PADDING,
    window.innerWidth - estimatedWidth - VIEWPORT_PADDING
  )
  const maximumTop = Math.max(
    VIEWPORT_PADDING,
    window.innerHeight - estimatedHeight - VIEWPORT_PADDING
  )

  return {
    left: clamp(desiredLeft, VIEWPORT_PADDING, maximumLeft),
    top: clamp(desiredTop, VIEWPORT_PADDING, maximumTop),
  }
}

export function HoverCard({
  children,
  content,
  testId,
  interactive = false,
  openOnFocus = false,
  cardClassName,
  estimatedWidth = 310,
  estimatedHeight = 220,
}: HoverCardProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const [position, setPosition] = useState<HoverCardPosition | null>(null)

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const close = useCallback(() => {
    clearTimers()
    setPosition(null)
  }, [clearTimers])

  const open = useCallback(() => {
    clearTimers()
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition(hoverCardPosition(rect, estimatedWidth, estimatedHeight))
  }, [clearTimers, estimatedHeight, estimatedWidth])

  const scheduleOpen = useCallback(() => {
    clearTimers()
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      open()
    }, DEFAULT_OPEN_DELAY_MS)
  }, [clearTimers, open])

  const scheduleClose = useCallback(() => {
    if (!interactive) {
      close()
      return
    }
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current === null) {
      closeTimerRef.current = window.setTimeout(close, CLOSE_DELAY_MS)
    }
  }, [close, interactive])

  const keepOpen = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  useEffect(
    () => () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    },
    []
  )

  useLayoutEffect(() => {
    if (!position) return
    const anchorRect = anchorRef.current?.getBoundingClientRect()
    const cardRect = cardRef.current?.getBoundingClientRect()
    if (!anchorRect || !cardRect) return

    const nextPosition = hoverCardPosition(
      anchorRect,
      cardRect.width || estimatedWidth,
      cardRect.height || estimatedHeight
    )
    if (nextPosition.left === position.left && nextPosition.top === position.top) return
    setPosition(nextPosition)
  }, [estimatedHeight, estimatedWidth, position])

  useEffect(() => {
    if (!position) return

    const handlePointerMove = (event: PointerEvent) => {
      const path = event.composedPath()
      if (path.includes(anchorRef.current as EventTarget)) {
        keepOpen()
        return
      }
      if (interactive && path.includes(cardRef.current as EventTarget)) {
        keepOpen()
        return
      }
      scheduleClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && cardRef.current?.contains(event.target)) return
      close()
    }

    document.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [close, interactive, keepOpen, position, scheduleClose])

  return (
    <div
      ref={anchorRef}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocusCapture={openOnFocus ? open : undefined}
      onBlurCapture={openOnFocus ? scheduleClose : undefined}
      onPointerDownCapture={close}
      onContextMenuCapture={close}
    >
      {children}
      {position &&
        createPortal(
          <div
            ref={cardRef}
            data-testid={testId}
            role={interactive ? 'dialog' : 'tooltip'}
            style={position}
            onMouseEnter={interactive ? keepOpen : undefined}
            onMouseLeave={interactive ? scheduleClose : undefined}
            onFocusCapture={interactive ? keepOpen : undefined}
            onBlurCapture={interactive ? scheduleClose : undefined}
            className={cn(
              'fixed z-[78] max-h-[calc(100vh-1rem)] overflow-y-auto rounded-xl border border-border bg-background p-3 text-xs text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
              interactive ? 'pointer-events-auto' : 'pointer-events-none',
              cardClassName
            )}
          >
            {content}
          </div>,
          document.body
        )}
    </div>
  )
}
