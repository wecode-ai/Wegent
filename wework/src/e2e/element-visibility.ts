interface VisibleRectangle {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** Geometry alone cannot prove visibility inside nested scrollports or overlays. */
export function readElementVisibility(element: HTMLElement): {
  visibleIntersection: VisibleRectangle | null
  hitTestVisible: boolean
} {
  const view = element.ownerDocument.defaultView
  if (!view) return { visibleIntersection: null, hitTestVisible: false }
  const rect = element.getBoundingClientRect()
  let left = Math.max(0, rect.left)
  let top = Math.max(0, rect.top)
  let right = Math.min(view.innerWidth, rect.right)
  let bottom = Math.min(view.innerHeight, rect.bottom)
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = view.getComputedStyle(ancestor)
    const bounds = ancestor.getBoundingClientRect()
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow)) {
      const edge = bounds.left + ancestor.clientLeft
      left = Math.max(left, edge)
      right = Math.min(right, edge + ancestor.clientWidth)
    }
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow)) {
      const edge = bounds.top + ancestor.clientTop
      top = Math.max(top, edge)
      bottom = Math.min(bottom, edge + ancestor.clientHeight)
    }
  }
  if (right <= left || bottom <= top) {
    return { visibleIntersection: null, hitTestVisible: false }
  }
  const visibleIntersection = {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
  const points = [
    [0.5, 0.5],
    [0.1, 0.1],
    [0.9, 0.1],
    [0.1, 0.9],
    [0.9, 0.9],
  ]
  const hitTestVisible =
    typeof element.ownerDocument.elementFromPoint === 'function' &&
    points.some(([x, y]) => {
      const hit = element.ownerDocument.elementFromPoint(
        left + visibleIntersection.width * x,
        top + visibleIntersection.height * y
      )
      return hit === element || (hit != null && element.contains(hit))
    })
  return { visibleIntersection, hitTestVisible }
}
