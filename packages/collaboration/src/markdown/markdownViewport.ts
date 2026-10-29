// Markdown and its asynchronous viewers must prepare within the same viewport window.
export const MARKDOWN_PRE_RENDER_DISTANCE = 1_600
export const MARKDOWN_ROOT_MARGIN = `${MARKDOWN_PRE_RENDER_DISTANCE}px 0px`

export function isNearMarkdownViewport(rect: DOMRect, viewport: DOMRect): boolean {
  return (
    viewport.width > 0 &&
    viewport.height > 0 &&
    rect.width > 0 &&
    rect.bottom >= viewport.top - MARKDOWN_PRE_RENDER_DISTANCE &&
    rect.top <= viewport.bottom + MARKDOWN_PRE_RENDER_DISTANCE
  )
}

export function windowViewport(): DOMRect {
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}
