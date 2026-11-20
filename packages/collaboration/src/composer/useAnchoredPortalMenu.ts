import { useMemo, type RefObject } from 'react'
import { useElementGeometry } from '../dom-events'

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
  const targets = useMemo(() => [anchorRef, menuRef], [anchorRef, menuRef])
  const geometry = useElementGeometry(targets, open)
  return useMemo<AnchoredPortalMenuLayout | null>(() => {
    const [anchor, menu] = geometry?.elements ?? []
    if (!geometry || !anchor || !menu) return null
    const availableAbove = Math.max(0, anchor.top - gap - VIEWPORT_MARGIN)
    const availableBelow = Math.max(
      0,
      geometry.viewportHeight - VIEWPORT_MARGIN - anchor.bottom - gap
    )
    const desiredHeight = menu.scrollHeight || menu.height
    const placeBelow =
      placement === 'prefer-below'
        ? desiredHeight <= availableBelow
        : availableBelow > availableAbove
    const maxHeight = placeBelow ? availableBelow : availableAbove
    const menuHeight = Math.min(desiredHeight, maxHeight)
    const maxLeft = Math.max(VIEWPORT_MARGIN, geometry.viewportWidth - VIEWPORT_MARGIN - menu.width)
    const preferredLeft = align === 'end' ? anchor.right - menu.width : anchor.left
    const left = Math.round(Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, maxLeft)))
    const top = Math.round(
      placeBelow ? anchor.bottom + gap : Math.max(VIEWPORT_MARGIN, anchor.top - gap - menuHeight)
    )
    return { left, maxHeight, top }
  }, [geometry, align, gap, placement])
}
