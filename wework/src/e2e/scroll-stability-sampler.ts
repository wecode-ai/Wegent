export interface ScrollStabilitySamplePoint {
  anchorTop: number
  footerLayout?: ReturnType<ReturnType<typeof createFooterSampler>>
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
  const sampleFooter = createFooterSampler()
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
    const anchorTop = anchor.getBoundingClientRect().top
    return {
      anchorTop,
      footerLayout: sampleFooter(scroller, anchorTop),
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

/** Record footer owners on the first visible frame and only when their layout changes. */
function createFooterSampler() {
  let previous: {
    scroller: HTMLElement
    nodes: (HTMLElement | null)[]
    key: string
    anchorTop: number
  } | null = null
  return (scroller: HTMLElement, anchorTop: number) => {
    const content = scroller.querySelector<HTMLElement>('[data-testid$="-content-footer"]')
    const sticky = scroller.querySelector<HTMLElement>('[data-testid$="-sticky-footer"]')
    const composer = scroller.querySelector<HTMLElement>(
      '[data-testid="desktop-floating-composer-card"]'
    )
    const tail = scroller.querySelector<HTMLElement>('[data-virtual-message-tail]')
    const form = scroller.querySelector('[data-testid="project-chat-composer-form"]')
    const nodes = [content, sticky, composer, tail]
    const heights = {
      contentFooter: content?.offsetHeight ?? null,
      stickyFooter: sticky?.offsetHeight ?? null,
      composer: composer?.offsetHeight ?? null,
      virtualTail: tail?.offsetHeight ?? null,
    }
    const controls = {
      shortCollapse: form?.getAttribute('data-short-collapse') ?? null,
      shortExpanded: form?.getAttribute('data-short-expanded') ?? null,
      sendDisabled:
        scroller.querySelector('[data-testid="send-message-button"]')?.matches(':disabled') ?? null,
    }
    const key = JSON.stringify([heights, controls, scroller.clientWidth, scroller.clientHeight])
    const changed =
      !previous ||
      previous.scroller !== scroller ||
      previous.key !== key ||
      nodes.some((node, index) => previous?.nodes[index] !== node) ||
      Math.abs(previous.anchorTop - anchorTop) > 0.5
    previous = { scroller, nodes, key, anchorTop }
    return changed
      ? {
          heights,
          controls,
          clientWidth: scroller.clientWidth,
          maximumScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
          footerOffsetHeight: (heights.contentFooter ?? 0) + (heights.stickyFooter ?? 0),
        }
      : undefined
  }
}
