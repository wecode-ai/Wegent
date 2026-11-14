import { useLayoutEffect, useState, type RefObject } from 'react'

export function useExperiencePaneWidth(container: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => {
      setWidth(element.getBoundingClientRect().width || window.innerWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [container])

  return width
}
