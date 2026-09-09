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
  pinned?: boolean
  onPinnedChange?: (pinned: boolean) => void
  closeLabel?: string
  cardClassName?: string
  estimatedWidth?: number
  estimatedHeight?: number
  placement?: 'anchor' | 'viewport-right'
  viewportTop?: number
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

function viewportRightHoverCardPosition(
  estimatedWidth: number,
  estimatedHeight: number,
  viewportTop: number
): HoverCardPosition {
  return {
    left: Math.max(VIEWPORT_PADDING, window.innerWidth - estimatedWidth - VIEWPORT_PADDING),
    top: clamp(
      viewportTop,
      VIEWPORT_PADDING,
      Math.max(VIEWPORT_PADDING, window.innerHeight - estimatedHeight - VIEWPORT_PADDING)
    ),
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
  pinned: controlledPinned,
  onPinnedChange,
  closeLabel = 'Close',
  cardClassName,
  estimatedWidth = 310,
  estimatedHeight = 220,
  placement = 'anchor',
  viewportTop = VIEWPORT_PADDING,
}: HoverCardProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const focusWithinRef = useRef(false)
  const pinnedRef = useRef(false)
  const openRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<HoverCardPosition | null>(null)
  const [uncontrolledPinned, setUncontrolledPinned] = useState(false)
  const pinned = controlledPinned ?? uncontrolledPinned
  const displayedOpen = open || pinned

  useEffect(() => {
    pinnedRef.current = pinned
  }, [pinned])

  const updatePinned = useCallback(
    (nextPinned: boolean) => {
      pinnedRef.current = nextPinned
      if (controlledPinned === undefined) setUncontrolledPinned(nextPinned)
      onPinnedChange?.(nextPinned)
    },
    [controlledPinned, onPinnedChange]
  )

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
    updatePinned(false)
    openRef.current = false
    setOpen(false)
    setPosition(null)
  }, [clearTimers, updatePinned])

  const show = useCallback(() => {
    clearTimers()
    if (openRef.current || !anchorRef.current) return
    openRef.current = true
    setOpen(true)
  }, [clearTimers])

  const scheduleOpen = useCallback(() => {
    clearTimers()
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      show()
    }, DEFAULT_OPEN_DELAY_MS)
  }, [clearTimers, show])

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
    updatePinned(true)
    keepOpen()
  }, [keepOpen, pinOnInteraction, updatePinned])

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
        show()
        return
      }
      keepOpen()
    },
    [keepOpen, openOnFocus, pin, shouldPinInteraction, show]
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

  // Measure while hidden, then reveal at the final position. Showing the
  // estimated position first makes tall cards visibly jump after calibration.
  // Calibrate only once because position-sensitive content can otherwise
  // alternate between two measured layouts.
  useLayoutEffect(() => {
    if (!displayedOpen) return
    const anchorRect = anchorRef.current?.getBoundingClientRect()
    const cardRect = cardRef.current?.getBoundingClientRect()
    if (!anchorRect || !cardRect) return

    const measuredWidth = cardRect.width || estimatedWidth
    const measuredHeight = cardRect.height || estimatedHeight
    setPosition(
      placement === 'viewport-right'
        ? viewportRightHoverCardPosition(measuredWidth, measuredHeight, viewportTop)
        : hoverCardPosition(anchorRect, measuredWidth, measuredHeight)
    )
  }, [displayedOpen, estimatedHeight, estimatedWidth, placement, viewportTop])

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
            if (shouldPinInteraction(event.target)) {
              keepOpen()
              return
            }
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
      {displayedOpen &&
        createPortal(
          <div
            ref={cardRef}
            data-testid={testId}
            data-pinned={pinned ? 'true' : 'false'}
            role={interactive ? 'dialog' : 'tooltip'}
            style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
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
