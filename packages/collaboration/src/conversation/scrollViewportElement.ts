/** Resolve a marked scroll viewport, skipping content wrappers that explicitly allow overflow. */
export function getScrollViewportElement(element: Element | null): HTMLElement | null {
  let scroller =
    element?.closest<HTMLElement>('[data-scroll-origin]') ??
    element?.querySelector<HTMLElement>('[data-scroll-origin]') ??
    null
  while (scroller) {
    const declaredOverflow = scroller.style.overflowY || scroller.style.overflow
    const allowsOverflow = declaredOverflow
      ? declaredOverflow === 'visible'
      : scroller.classList.contains('overflow-visible') ||
        scroller.classList.contains('overflow-y-visible')
    if (!allowsOverflow) break
    const outer = scroller.parentElement?.closest<HTMLElement>('[data-scroll-origin]')
    if (!outer) break
    scroller = outer
  }
  return scroller
}
