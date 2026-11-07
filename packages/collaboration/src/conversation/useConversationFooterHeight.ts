import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Measure replaced footer nodes once; their observer owns subsequent size changes. */
export function useConversationFooterHeight(
  contentRef: RefObject<HTMLDivElement | null>,
  stickyRef: RefObject<HTMLDivElement | null>,
): number {
  const [height, setHeight] = useState(0)
  const observed = useRef<{
    content: HTMLDivElement | null
    sticky: HTMLDivElement | null
    observer: ResizeObserver | null
  } | null>(null)

  useLayoutEffect(() => {
    const content = contentRef.current
    const sticky = stickyRef.current
    if (
      observed.current?.content === content &&
      observed.current?.sticky === sticky
    )
      return
    observed.current?.observer?.disconnect()
    const measure = () =>
      setHeight((content?.offsetHeight ?? 0) + (sticky?.offsetHeight ?? 0))
    measure()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (content) observer?.observe(content)
    if (sticky) observer?.observe(sticky)
    observed.current = { content, sticky, observer }
  })
  useLayoutEffect(
    () => () => {
      observed.current?.observer?.disconnect()
      observed.current = null
    },
    [],
  )
  return height
}
