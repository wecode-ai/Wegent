import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

const HOVER_OPEN_DELAY_MS = 450
const HOVER_CLOSE_DELAY_MS = 120
const HOVER_CARD_GAP = 10
const VIEWPORT_PADDING = 8

interface SidebarHoverCardProps {
  children: ReactNode
  content: ReactNode
  testId: string
  interactive?: boolean
  cardClassName?: string
}

interface HoverCardPosition {
  left: number
  top: number
}

export function SidebarHoverCard({
  children,
  content,
  testId,
  interactive = false,
  cardClassName,
}: SidebarHoverCardProps) {
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

  const scheduleOpen = useCallback(() => {
    clearTimers()
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      setPosition({
        left: Math.min(rect.right + HOVER_CARD_GAP, window.innerWidth - 328),
        top: Math.max(VIEWPORT_PADDING, Math.min(rect.top, window.innerHeight - 220)),
      })
    }, HOVER_OPEN_DELAY_MS)
  }, [clearTimers])

  const scheduleClose = useCallback(() => {
    if (!interactive) {
      close()
      return
    }
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
    }
    closeTimerRef.current = window.setTimeout(close, HOVER_CLOSE_DELAY_MS)
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

    document.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [close, interactive, keepOpen, position, scheduleClose])

  return (
    <div
      ref={anchorRef}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
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
            className={cn(
              'fixed z-[78] w-[310px] rounded-xl border border-border bg-background p-3 text-xs text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
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
