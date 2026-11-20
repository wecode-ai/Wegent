import { useLayoutEffect, useState, type RefObject } from 'react'

export function useExperiencePaneWidth(container: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    let frame = 0
    const measure = () => {
      setWidth(element.getBoundingClientRect().width || window.innerWidth)
    }
    const scheduleMeasure = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    measure()
    // Pane visibility can change when publishing width. Apply that change
    // outside the ResizeObserver delivery that measured it.
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(element)
    window.addEventListener('resize', scheduleMeasure)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [container])

  return width
}
