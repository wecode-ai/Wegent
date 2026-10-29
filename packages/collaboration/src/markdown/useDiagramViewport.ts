import { useLayoutEffect, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { useMarkdownWindowingScope } from './MarkdownWindowingScope'
import { getScrollViewportElement } from '../conversation/scrollViewportElement'
import { isNearMarkdownViewport, MARKDOWN_ROOT_MARGIN, windowViewport } from './markdownViewport'

// Search expands text, while diagrams prepare only within the Markdown render window.
export function useDiagramViewport(elementRef: RefObject<HTMLElement | null>): boolean {
  const scope = useMarkdownWindowingScope()
  const [enteredViewport, setEnteredViewport] = useState(
    () => typeof IntersectionObserver === 'undefined'
  )

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || enteredViewport || typeof IntersectionObserver === 'undefined') return
    const root = scope?.scrollElementRef?.current ?? getScrollViewportElement(element)
    let active = true
    let reobserveFrame: number | undefined
    const viewportRender = (
      viewport: DOMRect,
      rect = element.getBoundingClientRect()
    ): (() => void) | undefined => {
      if (!active) return
      if (
        rect.height <= 0 ||
        !isNearMarkdownViewport(rect, viewport) ||
        rect.right < viewport.left ||
        rect.left > viewport.right
      )
        return
      return () => {
        if (!active) return
        active = false
        setEnteredViewport(true)
      }
    }
    const renderNearViewport = () =>
      viewportRender(root?.getBoundingClientRect() ?? windowViewport())
    // Newly mounted virtual rows must not wait for a later intersection notification.
    const render = renderNearViewport()
    if (render) {
      render()
      return
    }
    const observer = new IntersectionObserver(
      entries => {
        if (!active || !entries.some(entry => entry.isIntersecting)) return
        // Entries may predate a search jump; the current geometry owns activation.
        const rect = element.getBoundingClientRect()
        const viewport = root?.getBoundingClientRect() ?? windowViewport()
        const render = viewportRender(viewport, rect)
        if (render) return render()
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          viewport.width <= 0 ||
          viewport.height <= 0 ||
          reobserveFrame !== undefined
        )
          return
        // Refresh a stale threshold even when a layout change produces no scroll event.
        reobserveFrame = window.requestAnimationFrame(() => {
          reobserveFrame = undefined
          if (!active) return
          observer.unobserve(element)
          observer.observe(element)
        })
      },
      { root, rootMargin: MARKDOWN_ROOT_MARGIN }
    )
    observer.observe(element)
    const target = root ?? window
    const checkViewport = () => {
      const render = renderNearViewport()
      if (render) flushSync(render)
    }
    const unregister = scope?.registerViewportCheck(viewportRender)
    if (!scope) target.addEventListener('scroll', checkViewport)
    return () => {
      active = false
      if (reobserveFrame !== undefined) window.cancelAnimationFrame(reobserveFrame)
      unregister?.()
      if (!scope) target.removeEventListener('scroll', checkViewport)
      observer.disconnect()
    }
  }, [elementRef, enteredViewport, scope])

  return enteredViewport
}
