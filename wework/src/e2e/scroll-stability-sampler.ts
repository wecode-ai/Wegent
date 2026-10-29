export interface ScrollStabilitySamplePoint {
  anchorTop: number
  clientHeight: number
  scrollHeight: number
  scrollOrigin: 'bottom' | 'top'
  scrollTop: number
  time: number
}

export interface ScrollStabilitySample {
  done: boolean
  frames: ScrollStabilitySamplePoint[]
  missingFrames: number
  scrollEvents: ScrollStabilitySamplePoint[]
  stop: () => void
}

/** Resolve the anchor and its owning viewport together, including the first pane commit. */
export function startScrollStabilitySampler(
  resolveAnchor: () => HTMLElement | undefined,
  resolveScrollers: () => HTMLElement[],
  durationMs: number
): ScrollStabilitySample {
  const startedAt = performance.now()
  let scroller: HTMLElement | null = null
  let timer = 0
  const sample: ScrollStabilitySample = {
    done: false,
    frames: [],
    missingFrames: 0,
    scrollEvents: [],
    stop: () => {
      if (sample.done) return
      sample.done = true
      window.clearInterval(timer)
      scroller?.removeEventListener('scroll', handleScroll)
      observer.disconnect()
    },
  }
  function capture(): ScrollStabilitySamplePoint | null {
    const anchor = resolveAnchor()
    const current = anchor
      ? resolveScrollers().find(viewport => viewport === anchor || viewport.contains(anchor))
      : undefined
    if (current !== scroller) {
      scroller?.removeEventListener('scroll', handleScroll)
      scroller = current ?? null
      scroller?.addEventListener('scroll', handleScroll)
    }
    if (!anchor || !scroller) return null
    return {
      anchorTop: anchor.getBoundingClientRect().top,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      scrollOrigin: scroller.dataset.scrollOrigin === 'bottom' ? 'bottom' : 'top',
      scrollTop: scroller.scrollTop,
      time: performance.now() - startedAt,
    }
  }
  function handleScroll(event: Event) {
    if (sample.done) return
    const point = capture()
    if (point && event.target === scroller) sample.scrollEvents.push(point)
  }
  function captureFrame() {
    if (sample.done) return
    const point = capture()
    if (point) sample.frames.push(point)
    else sample.missingFrames += 1
    if (performance.now() - startedAt >= durationMs) sample.stop()
  }
  const observer = new MutationObserver(captureFrame)
  // The old pane cannot report the first commit of its replacement.
  observer.observe(document.body, { characterData: true, childList: true, subtree: true })
  captureFrame()
  timer = window.setInterval(captureFrame, 16)
  return sample
}
