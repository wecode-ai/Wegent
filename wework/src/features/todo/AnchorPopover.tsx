import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const POPOVER_WIDTH = 280
const POPOVER_GAP = 8
const POPOVER_MARGIN = 16
const POPOVER_HEIGHT_ESTIMATE = 240

interface AnchorPopoverProps {
  anchor: HTMLElement | null
  title: string
  testId: string
  onClose: () => void
  children: ReactNode
  header?: ReactNode
  wide?: boolean
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
}: AnchorPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{
    left: number
    width: number
    top?: number
    bottom?: number
  } | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(wide ? 374 : POPOVER_WIDTH, window.innerWidth - POPOVER_MARGIN * 2)
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
      })
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
    }
  }, [anchor, wide])

  useEffect(() => {
    if (!anchor) return
    const frame = window.requestAnimationFrame(() => popoverRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [anchor])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!popoverRef.current?.contains(target) && !anchor?.contains(target)) {
        onClose()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    // Capture-phase so Escape closes the popover before an enclosing editor's
    // own Escape handler can close the whole detail panel.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [anchor, onClose])

  if (!anchor || !position) return null

  return createPortal(
    <div
      ref={popoverRef}
      data-testid={testId}
      role="dialog"
      tabIndex={-1}
      aria-label={title}
      className={`fixed z-system-popover rounded-xl border border-border/70 bg-popover text-text-primary shadow-lg ${header ? '' : 'p-1'}`}
      style={{
        left: position.left,
        width: position.width,
        bottom: position.bottom,
        top: position.top,
      }}
    >
      {header ?? <p className="px-2 pb-1.5 pt-2 text-xs font-medium text-text-primary">{title}</p>}
      <div
        className={
          wide
            ? `overflow-y-auto ${header ? '' : 'px-1 pb-1'}`
            : `max-h-[264px] overflow-y-auto ${header ? '' : 'px-1 pb-1'}`
        }
        style={wide ? { maxHeight: 'min(400px, calc(100vh - 112px))' } : undefined}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
