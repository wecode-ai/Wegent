import { useEffect, useState, type RefObject } from 'react'
import { useMarkdownWindowingScope } from './MarkdownWindowingScope'
import { getScrollViewportElement } from '../conversation/scrollViewportElement'

// Search needs all message text mounted, but must not start every offscreen diagram layout.
export function useDiagramViewport(elementRef: RefObject<HTMLElement | null>): boolean {
  const scope = useMarkdownWindowingScope()
  const [enteredViewport, setEnteredViewport] = useState(
    () => typeof IntersectionObserver === 'undefined'
  )

  useEffect(() => {
    const element = elementRef.current
    if (!element || enteredViewport || typeof IntersectionObserver === 'undefined') return
    const root = scope?.scrollElementRef?.current ?? getScrollViewportElement(element)
    let active = true
    const observer = new IntersectionObserver(
      entries => {
        if (!active || !entries.some(entry => entry.isIntersecting)) return
        // A search jump may have moved the diagram since this entry was queued.
        const rect = element.getBoundingClientRect()
        const viewport = root?.getBoundingClientRect() ?? {
          top: 0,
          bottom: window.innerHeight,
          left: 0,
          right: window.innerWidth,
        }
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.bottom <= viewport.top ||
          rect.top >= viewport.bottom ||
          rect.right <= viewport.left ||
          rect.left >= viewport.right
        )
          return
        active = false
        observer.disconnect()
        setEnteredViewport(true)
      },
      { root, rootMargin: '0px' }
    )
    observer.observe(element)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [elementRef, enteredViewport, scope])

  return enteredViewport
}
