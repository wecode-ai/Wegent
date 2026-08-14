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
}

// Shared shell for detail popovers anchored to a trigger button: positions
// itself above/below the anchor, closes on outside click or Escape, and
// renders the header plus a scrollable body in a portal.
export function AnchorPopover({ anchor, title, testId, onClose, children }: AnchorPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{
    left: number
    top?: number
    bottom?: number
  } | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      const spaceAbove = rect.top
      const spaceBelow = window.innerHeight - rect.bottom
      const placeAbove = spaceAbove >= POPOVER_HEIGHT_ESTIMATE || spaceAbove >= spaceBelow
      setPosition({
        left: Math.max(
          POPOVER_MARGIN,
          Math.min(
            rect.left + rect.width / 2 - POPOVER_WIDTH / 2,
            window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN
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
      aria-label={title}
      className="fixed z-system-popover w-[280px] rounded-xl border border-border/70 bg-background p-1 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
      style={{ left: position.left, bottom: position.bottom, top: position.top }}
    >
      <p className="px-2 pb-1.5 pt-2 text-xs font-medium text-text-primary">{title}</p>
      <div className="max-h-[264px] overflow-y-auto px-1 pb-1">{children}</div>
    </div>,
    document.body
  )
}
