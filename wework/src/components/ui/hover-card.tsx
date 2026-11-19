import {
  useCallback,
  useSyncExternalStore,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  useDocumentEvent,
  useWindowEvent,
  useElementGeometry,
} from '@wegent/collaboration/dom-events'
import { createHoverCardState } from './hover-card-state'

const CARD_GAP = 10
const VIEWPORT_PADDING = 8

interface HoverCardProps {
  children: ReactNode
  content: ReactNode
  testId: string
  interactive?: boolean
  // Opt into focus-driven visibility; interactive alone only enables pointer actions.
  openOnFocus?: boolean
  pinOnInteraction?: boolean
  pinOnInteractionSelector?: string
  pinned?: boolean
  onPinnedChange?: (pinned: boolean) => void
  onOpenChange?: (open: boolean) => void
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
  anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
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
  onOpenChange,
  closeLabel = 'Close',
  cardClassName,
  estimatedWidth = 310,
  estimatedHeight = 220,
  placement = 'anchor',
  viewportTop = VIEWPORT_PADDING,
}: HoverCardProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const pointerPinPendingRef = useRef(false)
  const [state] = useState(createHoverCardState)
  const subscribe = useCallback(
    (notify: () => void) =>
      state.subscribe(notify, { interactive, controlledPinned, onPinnedChange, onOpenChange }),
    [state, interactive, controlledPinned, onPinnedChange, onOpenChange]
  )
  const { open, uncontrolledPinned } = useSyncExternalStore(subscribe, state.getSnapshot)
  const pinned = controlledPinned ?? uncontrolledPinned
  const displayedOpen = open || pinned
  const { close, keepOpen, scheduleClose, scheduleOpen } = state
  const show = useCallback(() => {
    if (anchorRef.current) state.show()
  }, [state])
  const pin = useCallback(() => {
    if (pinOnInteraction) state.pin()
  }, [pinOnInteraction, state])

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
        if (pointerPinPendingRef.current) {
          keepOpen()
        } else {
          pin()
        }
      }
      if (!openOnFocus) return
      state.setFocusWithin(true)
      show()
    },
    [keepOpen, openOnFocus, pin, shouldPinInteraction, show, state]
  )

  const handleBlurCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      state.setFocusWithin(false)
      if (event.relatedTarget instanceof Node && anchorRef.current?.contains(event.relatedTarget)) {
        return
      }
      window.queueMicrotask(() => {
        if (!state.hasFocus()) scheduleClose()
      })
    },
    [scheduleClose, state]
  )

  useDocumentEvent(
    'pointermove',
    event => {
      const path = event.composedPath()
      if (
        path.includes(anchorRef.current as EventTarget) ||
        (interactive && path.includes(cardRef.current as EventTarget))
      ) {
        keepOpen()
      } else scheduleClose()
    },
    { enabled: displayedOpen, capture: true }
  )
  useWindowEvent(
    'keydown',
    event => {
      if (event.key === 'Escape') close()
    },
    { enabled: displayedOpen, capture: true }
  )
  useWindowEvent('blur', close, { enabled: displayedOpen })
  useWindowEvent(
    'scroll',
    event => {
      if (state.hasFocus() || state.isPinned()) return
      if (
        event.target instanceof Node &&
        (anchorRef.current?.contains(event.target) || cardRef.current?.contains(event.target))
      )
        return
      close()
    },
    { enabled: displayedOpen, capture: true }
  )

  return (
    <div
      ref={anchorRef}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocusCapture={openOnFocus || pinOnInteraction ? handleFocusCapture : undefined}
      onBlurCapture={openOnFocus ? handleBlurCapture : undefined}
      onPointerMoveCapture={interactive ? keepOpen : undefined}
      onPointerDownCapture={event => {
        pointerPinPendingRef.current = false
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
            pointerPinPendingRef.current = true
          }
          keepOpen()
          return
        }
        close()
      }}
      onPointerCancelCapture={() => {
        pointerPinPendingRef.current = false
      }}
      onContextMenuCapture={event => {
        pointerPinPendingRef.current = false
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
          <HoverCardPositioner
            anchorRef={anchorRef}
            cardRef={cardRef}
            estimatedWidth={estimatedWidth}
            estimatedHeight={estimatedHeight}
            placement={placement}
            viewportTop={viewportTop}
          >
            {position => (
              <div
                ref={cardRef}
                data-testid={testId}
                data-pinned={pinned ? 'true' : 'false'}
                role={interactive ? 'dialog' : 'tooltip'}
                style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
                onMouseEnter={interactive ? keepOpen : undefined}
                onMouseLeave={interactive ? scheduleClose : undefined}
                onClickCapture={event => {
                  if (!pointerPinPendingRef.current) return
                  pointerPinPendingRef.current = false
                  if (!shouldPinInteraction(event.target)) return
                  window.queueMicrotask(pin)
                }}
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
                    className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition hover:bg-muted hover:text-text-primary"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
                {content}
              </div>
            )}
          </HoverCardPositioner>,
          document.body
        )}
    </div>
  )
}

/** Calibrate each opening once, before revealing position-sensitive card content. */
function HoverCardPositioner({
  anchorRef,
  cardRef,
  estimatedWidth,
  estimatedHeight,
  placement,
  viewportTop,
  children,
}: {
  anchorRef: RefObject<HTMLDivElement | null>
  cardRef: RefObject<HTMLDivElement | null>
  estimatedWidth: number
  estimatedHeight: number
  placement: 'anchor' | 'viewport-right'
  viewportTop: number
  children(position: HoverCardPosition | null): ReactNode
}) {
  const key = JSON.stringify([estimatedWidth, estimatedHeight, placement, viewportTop])
  const [calibration, setCalibration] = useState<{
    key: string
    position: HoverCardPosition | null
  }>({
    key,
    position: null,
  })
  const position = calibration.key === key ? calibration.position : null
  const geometry = useElementGeometry([anchorRef, cardRef], position === null)
  if (calibration.key !== key) setCalibration({ key, position: null })
  const anchor = geometry?.elements[0]
  const card = geometry?.elements[1]
  if (!position && anchor && card) {
    const width = card.width || estimatedWidth
    const height = card.height || estimatedHeight
    setCalibration({
      key,
      position:
        placement === 'viewport-right'
          ? viewportRightHoverCardPosition(width, height, viewportTop)
          : hoverCardPosition(anchor, width, height),
    })
  }
  return children(position)
}
