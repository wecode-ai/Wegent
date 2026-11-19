export interface ReadableScrollMemory {
  located: boolean
  cancelled: boolean
  readingSize?: { width: number; height: number }
}

export interface ReadableScrollOptions {
  selector: string
  matchAttribute?: string
  matchValue?: string
  occlusionSelector?: string
  ready: boolean
}

function scrollViewport(container: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = container; node; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    if (/^(auto|scroll)$/.test(style.overflowY || style.overflow)) return node
  }
  return null
}

function readingBounds(viewport: HTMLElement | null, occlusionSelector?: string) {
  const rect = viewport?.getBoundingClientRect()
  const top = rect?.top ?? 0
  let bottom = rect?.bottom ?? window.innerHeight
  const occlusion = occlusionSelector
    ? viewport?.querySelector<HTMLElement>(occlusionSelector)
    : null
  const obstruction = occlusion?.getBoundingClientRect()
  if (obstruction && obstruction.height > 0) bottom = Math.min(bottom, obstruction.top)
  return { top, bottom, height: bottom - top, width: rect?.width ?? window.innerWidth }
}

function revealTarget(
  target: HTMLElement,
  viewport: HTMLElement | null,
  bounds: ReturnType<typeof readingBounds>
): boolean {
  target.scrollIntoView?.({
    behavior: 'instant',
    block: target.getBoundingClientRect().height > bounds.height ? 'start' : 'center',
  })
  if (viewport) {
    const rect = target.getBoundingClientRect()
    if (rect.top < bounds.top || rect.bottom > bounds.bottom) {
      const top = bounds.top + (rect.height > bounds.height ? 0 : (bounds.height - rect.height) / 2)
      viewport.scrollTop += rect.top - top
    }
  }
  const rect = target.getBoundingClientRect()
  return (
    rect.top >= bounds.top - 1 &&
    (rect.height <= bounds.height ? rect.bottom <= bounds.bottom + 1 : rect.top < bounds.bottom)
  )
}

/** Observe one native anchor until the reader cancels or the committed owner detaches. */
export function observeReadableScrollRequest(
  container: HTMLElement,
  { selector, matchAttribute, matchValue, occlusionSelector, ready }: ReadableScrollOptions,
  memory: ReadableScrollMemory,
  onLocated: () => void
): () => void {
  let disposed = false
  let frame = 0
  const viewport = scrollViewport(container)
  const eventTarget = viewport ?? window
  const currentBounds = readingBounds(viewport, occlusionSelector)
  let { width, height } = memory.located && memory.readingSize ? memory.readingSize : currentBounds

  const cleanup = () => {
    disposed = true
    window.cancelAnimationFrame(frame)
    resize.disconnect()
    mutations.disconnect()
    eventTarget.removeEventListener('wheel', cancel)
    eventTarget.removeEventListener('touchstart', cancelPointer)
    eventTarget.removeEventListener('pointerdown', cancelPointer)
    eventTarget.removeEventListener('keydown', cancelKey)
    window.removeEventListener('resize', schedule)
  }
  const cancel = () => {
    // Initial layout may still need a late obstruction to establish readable bounds.
    if (memory.located || !ready) {
      memory.cancelled = true
      cleanup()
    }
  }
  const cancelPointer = (event: Event) => {
    if (
      occlusionSelector &&
      event.target instanceof Element &&
      event.target.closest(occlusionSelector)
    )
      return
    cancel()
  }
  const cancelKey = (event: Event) => {
    const node = event.target instanceof HTMLElement ? event.target : null
    if (node?.closest('input, textarea, [contenteditable="true"]')) return
    if (
      ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(
        (event as KeyboardEvent).key
      )
    )
      cancel()
  }
  const locate = () => {
    frame = 0
    if (disposed || !ready) return
    const target = Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
      node => !matchAttribute || node.getAttribute(matchAttribute) === matchValue
    )
    if (!target) return
    const bounds = readingBounds(viewport, occlusionSelector)
    if (bounds.width <= 0 || bounds.height <= 0 || target.getBoundingClientRect().height <= 0)
      return
    resize.observe(target)
    if (!revealTarget(target, viewport, bounds)) return
    memory.readingSize = { width: bounds.width, height: bounds.height }
    if (!memory.located) onLocated()
    memory.located = true
    mutations.disconnect()
    resize.disconnect()
    if (viewport) resize.observe(viewport)
    const occlusion = occlusionSelector
      ? viewport?.querySelector<HTMLElement>(occlusionSelector)
      : null
    if (occlusion) resize.observe(occlusion)
  }
  const schedule = () => {
    if (!disposed && !frame) frame = window.requestAnimationFrame(locate)
  }
  const resize = new ResizeObserver(() => {
    const bounds = readingBounds(viewport, occlusionSelector)
    if (!memory.located || bounds.width !== width || bounds.height !== height) schedule()
    width = bounds.width
    height = bounds.height
  })
  const mutations = new MutationObserver(schedule)
  if (!memory.located) resize.observe(container)
  if (viewport) resize.observe(viewport)
  const occlusion = occlusionSelector
    ? viewport?.querySelector<HTMLElement>(occlusionSelector)
    : null
  if (occlusion) resize.observe(occlusion)
  if (!memory.located) mutations.observe(container, { childList: true, subtree: true })
  eventTarget.addEventListener('wheel', cancel, { passive: true })
  eventTarget.addEventListener('touchstart', cancelPointer, { passive: true })
  eventTarget.addEventListener('pointerdown', cancelPointer, { passive: true })
  eventTarget.addEventListener('keydown', cancelKey)
  window.addEventListener('resize', schedule)
  // Defer native positioning until parent scroll resets have completed.
  if (!memory.located || width !== currentBounds.width || height !== currentBounds.height)
    schedule()
  return cleanup
}
