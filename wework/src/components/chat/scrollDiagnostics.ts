// TEMP-DIAG (WORK-447): scroll diagnostics for the reported "viewport retreats during fast
// upward scroll in a long conversation" issue. Removed after the investigation.
//
// - All entries are appended to `window.__weworkScrollDiag` (cheap, no I/O).
// - "important" entries also print to the renderer console so a dev run shows them live.
// - Run `__dumpWeworkScrollDiag()` in DevTools to print the full captured timeline.
export function scrollDiag(entry: string, important = false): void {
  try {
    if (typeof window === 'undefined') return
    const host = window as unknown as {
      __weworkScrollDiag?: string[]
      __dumpWeworkScrollDiag?: () => number
    }
    const entries = (host.__weworkScrollDiag ??= [])
    entries.push(`${String(Date.now() % 1_000_000).padStart(6, '0')} ${entry}`)
    if (entries.length > 4000) entries.splice(0, entries.length - 4000)
    host.__dumpWeworkScrollDiag = () => {
      console.warn(
        `%c=== WEWORK-SCROLL-DIAG (${entries.length} entries) ===`,
        'color:#b91c1c;font-weight:bold'
      )
      console.warn(entries.join('\n'))
      return entries.length
    }
    if (important) {
      console.warn(`[WEWORK-SCROLL-DIAG] ${entry}`)
    }
  } catch {
    // Diagnostics must never affect behavior.
  }
}

// TEMP-DIAG (WORK-447): short caller chain so a scroll-position write can be attributed.
export function scrollDiagCaller(): string {
  try {
    return (new Error().stack ?? '')
      .split('\n')
      .slice(2, 5)
      .map(line =>
        line
          .trim()
          .replace(/^\s*at\s+/, '')
          .replace(/:\d+:\d+\)?$/, '')
      )
      .join(' < ')
  } catch {
    return 'unknown'
  }
}

// TEMP-DIAG (WORK-447): record every direct write to the scroller's scroll position together
// with the caller, so an unexpected "jumped back to the bottom" can be told apart from a
// layout reset (content emptied/replaced) that no JavaScript wrote at all.
export function installScrollPositionTracer(scroller: HTMLElement): void {
  // The diagnostics are only useful in a running app; leave unit-test environments alone.
  if (typeof process !== 'undefined' && process.env?.VITEST) return
  const traced = scroller as HTMLElement & { __weworkScrollTraceInstalled?: boolean }
  if (traced.__weworkScrollTraceInstalled) return
  // Never replace an element that already defines its own offset (synthetic scrollers do).
  if (Object.getOwnPropertyDescriptor(scroller, 'scrollTop')) return
  traced.__weworkScrollTraceInstalled = true

  const descriptor =
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(scroller), 'scrollTop') ??
    Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  if (!descriptor?.get || !descriptor.set) return

  const { get, set } = descriptor
  scrollDiag(`TRACER-ARM origin=${scroller.dataset.scrollOrigin ?? 'none'}`)
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => get.call(scroller) as number,
    set: (value: number) => {
      const previous = get.call(scroller) as number
      if (Math.abs(previous - value) >= 0.5) {
        scrollDiag(
          `WRITE-SCROLLTOP ${Math.round(previous)} -> ${Math.round(value)} h=${scroller.scrollHeight} caller=${scrollDiagCaller()}`,
          true
        )
      }
      set.call(scroller, value)
    },
  })

  new MutationObserver(() => {
    scrollDiag(`SCROLL-ORIGIN ${scroller.dataset.scrollOrigin ?? 'none'}`, true)
  }).observe(scroller, { attributes: true, attributeFilter: ['data-scroll-origin'] })
}

// TEMP-DIAG (WORK-447): describes what the reader actually has under the top edge of the
// viewport, so a scroll-offset change can be classified as visible or invisible.
export function describeViewportTop(content: HTMLElement | null, scroller: HTMLElement): string {
  if (!content) return 'none'
  const scrollerTop = scroller.getBoundingClientRect().top
  for (const row of content.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > scrollerTop) {
      return `${row.dataset.messageId ?? '?'}@${Math.round(rect.top - scrollerTop)}`
    }
  }
  return 'none'
}

// TEMP-DIAG (WORK-447): confirm the diagnostics are present in the running build.
scrollDiag('DIAG-ARMED (WORK-447 scroll diagnostics loaded)', true)
