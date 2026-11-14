export interface MenuAnchor {
  x: number
  y: number
  width: number
  height: number
}

export function conversationMenuFrame(
  anchor: MenuAnchor,
  viewport: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number },
  contentHeight: number
): MenuAnchor {
  const left = insets.left + 8
  const right = viewport.width - insets.right - 8
  const top = Math.max(insets.top, 8)
  const bottom = viewport.height - insets.bottom - 8
  const width = Math.min(245, Math.max(0, right - left))
  const height = Math.min(contentHeight || bottom - top, Math.max(0, bottom - top))
  return {
    x: Math.max(left, Math.min(anchor.x + anchor.width - width, right - width)),
    y: Math.max(top, Math.min(anchor.y, bottom - height)),
    width,
    height,
  }
}
