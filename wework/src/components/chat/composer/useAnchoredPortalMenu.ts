import { useLayoutEffect, useState, type RefObject } from 'react'

interface AnchoredPortalMenuLayout {
  left: number
  maxHeight: number
  top: number
}

const VIEWPORT_MARGIN = 8
const TRIGGER_GAP = 8

export function useAnchoredPortalMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>
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
      const maxHeight = Math.max(0, anchorRect.top - TRIGGER_GAP - VIEWPORT_MARGIN)
      const menuHeight = Math.min(menu.scrollHeight || menuRect.height, maxHeight)
      const maxLeft = Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - VIEWPORT_MARGIN - menuRect.width
      )
      const left = Math.round(Math.max(VIEWPORT_MARGIN, Math.min(anchorRect.left, maxLeft)))
      const top = Math.round(Math.max(VIEWPORT_MARGIN, anchorRect.top - TRIGGER_GAP - menuHeight))

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
  }, [anchorRef, menuRef, open])

  return open ? layout : null
}
