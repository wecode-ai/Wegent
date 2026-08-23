import { useLayoutEffect, useState, type RefObject } from 'react'

interface AnchoredPortalMenuLayout {
  left: number
  maxHeight: number
  top: number
}

const VIEWPORT_MARGIN = 8
const TRIGGER_GAP = 8

interface AnchoredPortalMenuOptions {
  align?: 'start' | 'end'
  gap?: number
  placement?: 'best-fit' | 'prefer-below'
}

export function useAnchoredPortalMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  { align = 'start', gap = TRIGGER_GAP, placement = 'best-fit' }: AnchoredPortalMenuOptions = {}
) {
  const [layout, setLayout] = useState<AnchoredPortalMenuLayout | null>(null)

  useLayoutEffect(() => {
    if (!open) return

    const update = () => {
      const anchor = anchorRef.current
      const menu = menuRef.current
      if (!anchor || !menu) return

      const anchorRect = anchor.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const availableAbove = Math.max(0, anchorRect.top - gap - VIEWPORT_MARGIN)
      const availableBelow = Math.max(
        0,
        window.innerHeight - VIEWPORT_MARGIN - anchorRect.bottom - gap
      )
      const desiredHeight = menu.scrollHeight || menuRect.height
      const placeBelow =
        placement === 'prefer-below'
          ? desiredHeight <= availableBelow
          : availableBelow > availableAbove
      const maxHeight = placeBelow ? availableBelow : availableAbove
      const menuHeight = Math.min(desiredHeight, maxHeight)
      const maxLeft = Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - VIEWPORT_MARGIN - menuRect.width
      )
      const preferredLeft = align === 'end' ? anchorRect.right - menuRect.width : anchorRect.left
      const left = Math.round(Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, maxLeft)))
      const top = Math.round(
        placeBelow
          ? anchorRect.bottom + gap
          : Math.max(VIEWPORT_MARGIN, anchorRect.top - gap - menuHeight)
      )

      setLayout(current => {
        if (current?.left === left && current.top === top && current.maxHeight === maxHeight) {
          return current
        }
        return { left, maxHeight, top }
      })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update())
    if (anchorRef.current) observer?.observe(anchorRef.current)
    if (menuRef.current) observer?.observe(menuRef.current)

    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      observer?.disconnect()
    }
  }, [align, anchorRef, gap, menuRef, open, placement])

  return open ? layout : null
}
