export interface ModelMenuAnchor {
  x: number
  y: number
  width: number
  height: number
}

interface ModelMenuViewport {
  width: number
  height: number
  topInset: number
  bottomInset: number
}

export function modelPopoverLayout(
  anchor: ModelMenuAnchor,
  viewport: ModelMenuViewport,
  contentHeight: number
) {
  const edge = 16
  const topEdge = viewport.topInset + edge
  const bottomEdge = viewport.height - viewport.bottomInset - edge
  const width = Math.min(264, Math.max(0, viewport.width - edge * 2))
  const maxHeight = Math.max(0, bottomEdge - topEdge)
  const height = Math.min(contentHeight || maxHeight, maxHeight)
  const left = Math.min(
    Math.max(edge, anchor.x + anchor.width - width),
    viewport.width - edge - width
  )
  const top = Math.min(Math.max(topEdge, anchor.y + anchor.height - height), bottomEdge - height)
  return { left, top, width, height }
}
