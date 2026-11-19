import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { useFocusRequest, useDocumentEvent } from '@wegent/collaboration/dom-events'
import { createPortal } from 'react-dom'

const POPOVER_WIDTH = 280
const POPOVER_GAP = 8
const POPOVER_MARGIN = 16
const POPOVER_HEIGHT_ESTIMATE = 240
const OPEN_POPOVER_BODY_ATTRIBUTE = 'data-wework-anchor-popover-open'

let openPopoverCount = 0

interface AnchorPopoverProps {
  anchor: HTMLElement | null
  title: string
  testId: string
  onClose: () => void
  children: ReactNode
  header?: ReactNode
  wide?: boolean
  profile?: boolean
  suspended?: boolean
  onBodyScroll?: (scrollTop: number) => void
  bodyRef?: Ref<HTMLDivElement>
}

// Shared shell for detail popovers anchored to a trigger button: positions
// itself above/below the anchor, closes on outside click or Escape, and
// renders the header plus a scrollable body in a portal.
export function AnchorPopover({
  anchor,
  title,
  testId,
  onClose,
  children,
  header,
  wide = false,
  profile = false,
  suspended = false,
  onBodyScroll,
  bodyRef,
}: AnchorPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{
    left: number
    width: number
    top?: number
    bottom?: number
    maxHeight?: number
  } | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(
        profile ? 300 : wide ? 374 : POPOVER_WIDTH,
        window.innerWidth - POPOVER_MARGIN * 2
      )
      const spaceAbove = rect.top
      const spaceBelow = window.innerHeight - rect.bottom
      const placeAbove = spaceAbove >= POPOVER_HEIGHT_ESTIMATE || spaceAbove >= spaceBelow
      setPosition({
        width,
        left: Math.max(
          POPOVER_MARGIN,
          Math.min(
            rect.left + rect.width / 2 - width / 2,
            window.innerWidth - width - POPOVER_MARGIN
          )
        ),
        bottom: placeAbove ? window.innerHeight - rect.top + POPOVER_GAP : undefined,
        top: !placeAbove ? rect.bottom + POPOVER_GAP : undefined,
        maxHeight: Math.max(
          0,
          (placeAbove ? spaceAbove : spaceBelow) - POPOVER_GAP - POPOVER_MARGIN
        ),
      })
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [anchor, wide, profile])

  useFocusRequest(popoverRef, anchor ?? undefined, {
    enabled: Boolean(anchor),
    animationFrame: true,
  })
  const attachPopover = useCallback((node: HTMLDivElement | null) => {
    popoverRef.current = node
    if (!node) return
    openPopoverCount += 1
    document.body.setAttribute(OPEN_POPOVER_BODY_ATTRIBUTE, '')
    return () => {
      popoverRef.current = null
      openPopoverCount = Math.max(0, openPopoverCount - 1)
      if (openPopoverCount === 0) document.body.removeAttribute(OPEN_POPOVER_BODY_ATTRIBUTE)
    }
  }, [])
  useDocumentEvent(
    'pointerdown',
    event => {
      const target = event.target as Node
      if (!popoverRef.current?.contains(target) && !anchor?.contains(target)) onClose()
    },
    { enabled: !suspended }
  )
  useDocumentEvent(
    'keydown',
    event => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    },
    { enabled: !suspended, capture: true }
  )

  if (!anchor || !position) return null

  return createPortal(
    <div
      ref={attachPopover}
      data-testid={testId}
      role="dialog"
      tabIndex={-1}
      aria-label={title}
      inert={suspended}
      aria-hidden={suspended || undefined}
      className={`electron-titlebar-interactive-region fixed flex flex-col overflow-hidden ${suspended ? 'z-modal' : 'z-system-popover'} border border-border/70 bg-popover text-text-primary shadow-lg ${profile ? 'rounded-2xl' : `rounded-xl ${header ? '' : 'p-1'}`}`}
      style={{
        left: position.left,
        width: position.width,
        bottom: position.bottom,
        top: position.top,
        maxHeight: position.maxHeight,
      }}
    >
      {header ??
        (!profile && (
          <p className="shrink-0 px-2 pb-1.5 pt-2 text-xs font-medium text-text-primary">{title}</p>
        ))}
      <div
        ref={bodyRef}
        onScroll={onBodyScroll ? event => onBodyScroll(event.currentTarget.scrollTop) : undefined}
        className={
          profile
            ? 'min-h-0 overflow-y-auto overscroll-contain'
            : wide
              ? `min-h-0 overflow-y-auto overscroll-contain ${header ? '' : 'px-1 pb-1'}`
              : `min-h-0 max-h-[264px] overflow-y-auto overscroll-contain ${header ? '' : 'px-1 pb-1'}`
        }
        style={wide ? { maxHeight: 'min(400px, calc(100vh - 112px))' } : undefined}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
