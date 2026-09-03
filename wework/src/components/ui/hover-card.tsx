import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
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
  pinOnInteraction?: boolean
  pinOnInteractionSelector?: string
  closeLabel?: string
  cardClassName?: string
  estimatedWidth?: number
  estimatedHeight?: number
}

type HoverCardPosition = CSSProperties & {
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
  pinOnInteraction = false,
  pinOnInteractionSelector,
  closeLabel = 'Close',
  cardClassName,
  estimatedWidth = 310,
  estimatedHeight = 220,
}: HoverCardProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const focusWithinRef = useRef(false)
  const pinnedRef = useRef(false)
  const [position, setPosition] = useState<HoverCardPosition | null>(null)
  const [pinned, setPinned] = useState(false)
  const isOpen = position !== null

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
    focusWithinRef.current = false
    pinnedRef.current = false
    setPinned(false)
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
    if (pinnedRef.current) return
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

  const pin = useCallback(() => {
    if (!pinOnInteraction) return
    pinnedRef.current = true
    setPinned(true)
    keepOpen()
  }, [keepOpen, pinOnInteraction])

  const shouldPinInteraction = useCallback(
    (target: EventTarget | null) =>
      pinOnInteraction &&
      target instanceof Element &&
      (!pinOnInteractionSelector || Boolean(target.closest(pinOnInteractionSelector))),
    [pinOnInteraction, pinOnInteractionSelector]
  )

  const handleFocusCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const focusIsInsideAnchor =
        event.target instanceof Node && Boolean(anchorRef.current?.contains(event.target))
      if (
        shouldPinInteraction(event.target) &&
        event.target instanceof Node &&
        !focusIsInsideAnchor
      ) {
        pin()
      }
      if (focusIsInsideAnchor && !openOnFocus) return
      focusWithinRef.current = true
      if (openOnFocus) {
        open()
        return
      }
      keepOpen()
    },
    [keepOpen, open, openOnFocus, pin, shouldPinInteraction]
  )

  const handleBlurCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      focusWithinRef.current = false
      if (event.relatedTarget instanceof Node && anchorRef.current?.contains(event.relatedTarget)) {
        return
      }
      window.queueMicrotask(() => {
        if (!focusWithinRef.current) scheduleClose()
      })
    },
    [scheduleClose]
  )

  useEffect(
    () => () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    },
    []
  )

  // Calibrate once per open transition. Re-running from the position update can
  // make position-sensitive content alternate between two measured layouts.
  useLayoutEffect(() => {
    if (!isOpen) return
    const anchorRect = anchorRef.current?.getBoundingClientRect()
    const cardRect = cardRef.current?.getBoundingClientRect()
    if (!anchorRect || !cardRect) return

    const nextPosition = hoverCardPosition(
      anchorRect,
      cardRect.width || estimatedWidth,
      cardRect.height || estimatedHeight
    )
    setPosition(current => {
      if (!current || (nextPosition.left === current.left && nextPosition.top === current.top)) {
        return current
      }
      return nextPosition
    })
  }, [estimatedHeight, estimatedWidth, isOpen])

  useEffect(() => {
    if (!position) return

    const handlePointerMove = (event: PointerEvent) => {
      if (focusWithinRef.current || pinnedRef.current) {
        keepOpen()
        return
      }
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
      if (focusWithinRef.current || pinnedRef.current) return
      if (
        event.target instanceof Node &&
        (anchorRef.current?.contains(event.target) || cardRef.current?.contains(event.target))
      ) {
        return
      }
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
      onFocusCapture={interactive || openOnFocus ? handleFocusCapture : undefined}
      onBlurCapture={interactive || openOnFocus ? handleBlurCapture : undefined}
      onPointerMoveCapture={interactive ? keepOpen : undefined}
      onPointerDownCapture={event => {
        if (interactive) {
          if (event.target instanceof Node && anchorRef.current?.contains(event.target)) {
            close()
            return
          }
          if (
            shouldPinInteraction(event.target) &&
            event.target instanceof Node &&
            !anchorRef.current?.contains(event.target)
          ) {
            pin()
          }
          keepOpen()
          return
        }
        close()
      }}
      onContextMenuCapture={event => {
        if (interactive) {
          if (event.target instanceof Node && anchorRef.current?.contains(event.target)) {
            close()
            return
          }
          keepOpen()
          return
        }
        close()
      }}
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
              'fixed z-[78] max-h-[calc(100vh-1rem)] overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-background p-3 text-xs text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
              interactive ? 'pointer-events-auto' : 'pointer-events-none',
              pinned && 'pr-10',
              cardClassName
            )}
          >
            {pinned ? (
              <button
                type="button"
                data-testid={`${testId}-close`}
                onPointerDown={event => event.stopPropagation()}
                onClick={event => {
                  event.stopPropagation()
                  close()
                }}
                aria-label={closeLabel}
                className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition hover:bg-muted hover:text-text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
            {content}
          </div>,
          document.body
        )}
    </div>
  )
}
