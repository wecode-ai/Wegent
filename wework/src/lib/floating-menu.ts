export type FloatingMenuPlacement = 'above' | 'below'

export interface FloatingMenuBounds {
  top: number
  bottom: number
}

export function getFloatingMenuVisibleBounds(
  element: HTMLElement | null,
  margin = 16
): FloatingMenuBounds {
  let top = margin
  let bottom = window.innerHeight - margin
  let current = element?.parentElement

  while (current) {
    const style = window.getComputedStyle(current)
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflowY}${style.overflow}`)) {
      const rect = current.getBoundingClientRect()
      top = Math.max(top, rect.top + margin)
      bottom = Math.min(bottom, rect.bottom - margin)
    }
    current = current.parentElement
  }

  return { top, bottom }
}

export function calculateFloatingMenuLayout({
  triggerRect,
  visibleBounds,
  preferredPlacement,
  maxHeight,
  gap = 8,
}: {
  triggerRect: DOMRect
  visibleBounds: FloatingMenuBounds
  preferredPlacement: FloatingMenuPlacement
  maxHeight: number
  gap?: number
}): { placement: FloatingMenuPlacement; maxHeight: number } {
  const spaceAbove = Math.max(triggerRect.top - visibleBounds.top - gap, 0)
  const spaceBelow = Math.max(visibleBounds.bottom - triggerRect.bottom - gap, 0)
  const placement =
    preferredPlacement === 'above'
      ? spaceAbove >= spaceBelow
        ? 'above'
        : 'below'
      : spaceBelow >= spaceAbove
        ? 'below'
        : 'above'
  const availableSpace = placement === 'above' ? spaceAbove : spaceBelow

  return {
    placement,
    maxHeight: Math.min(maxHeight, availableSpace),
  }
}
