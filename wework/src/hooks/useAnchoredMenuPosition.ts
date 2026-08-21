import { useLayoutEffect, useState, type RefObject } from 'react'

export interface AnchoredMenuPosition {
  top: number
  right: number
  width: number
}

/**
 * Positions a portal-rendered fixed menu below its trigger and re-anchors it
 * while open, so scrolling the page cannot tear the menu away from the field.
 */
export function useAnchoredMenuPosition({
  open,
  anchorRef,
  menuRef,
  menuWidth,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  menuRef: RefObject<HTMLElement | null>
  menuWidth?: number
}): AnchoredMenuPosition | null {
  const [position, setPosition] = useState<AnchoredMenuPosition | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const triggerRect = anchorRef.current?.getBoundingClientRect()
      if (!triggerRect) return
      const width = Math.max(180, triggerRect.width, menuWidth ?? 0)
      const belowTop = triggerRect.bottom + 6
      const estimatedHeight = Math.min(360, menuRef.current?.scrollHeight ?? 320)
      const top =
        belowTop + estimatedHeight <= window.innerHeight - 8
          ? belowTop
          : Math.max(8, triggerRect.top - estimatedHeight - 6)
      setPosition({
        top,
        right: Math.max(8, window.innerWidth - triggerRect.right),
        width,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [menuWidth, open, anchorRef, menuRef])

  return position
}
