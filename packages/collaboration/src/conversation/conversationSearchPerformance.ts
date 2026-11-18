import { observeBrowserPerformance } from '@wegent/chat-core/browser-performance'

type SearchPerformanceEventName = 'search-long-task' | 'search-long-frame' | 'search-slow-script'

// Observe browser-provided timings only while the reader is editing a search query.
export function createConversationSearchPerformanceCapture(
  record: (name: SearchPerformanceEventName, details: Record<string, number | string>) => void,
  captureWindowMs: number
) {
  let observer: ReturnType<typeof observeBrowserPerformance> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let captureUntil = 0

  const stop = () => {
    observer?.stop()
    observer = null
    if (timer !== null) clearTimeout(timer)
    timer = null
    captureUntil = 0
  }

  const capture = () => {
    captureUntil = performance.now() + captureWindowMs
    if (!observer) {
      observer = observeBrowserPerformance((kind, details) => {
        if (performance.now() >= captureUntil) return
        record(`search-${kind}` as SearchPerformanceEventName, details)
      })
    }
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(stop, captureWindowMs)
  }

  return { capture, stop }
}
