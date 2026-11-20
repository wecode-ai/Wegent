import {
  cancelSafeAnimationFrame,
  requestSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from './safeAnimationFrame'

interface StreamingInput {
  content: string
  isStreaming: boolean
  flushIntervalMs: number
}

/** Keep a single flush deadline while streamed deltas replace the pending target. */
export function createBufferedStreamingTextStore(initialContent: string) {
  let snapshot = initialContent
  let input: StreamingInput = { content: initialContent, isStreaming: false, flushIntervalMs: 0 }
  let frame: SafeAnimationFrameHandle | null = null
  let fallback: ReturnType<typeof setTimeout> | null = null
  let batch: ReturnType<typeof setTimeout> | null = null
  let revision = 0
  let teardownRevision = 0
  const listeners = new Set<() => void>()

  const cancel = () => {
    revision++
    if (frame) cancelSafeAnimationFrame(frame)
    if (fallback !== null) clearTimeout(fallback)
    if (batch !== null) clearTimeout(batch)
    frame = null
    fallback = null
    batch = null
  }
  const flush = () => {
    cancel()
    if (!listeners.size || snapshot === input.content) return
    snapshot = input.content
    listeners.forEach(listener => listener())
  }
  const update = () => {
    if (
      !input.isStreaming ||
      !input.content.startsWith(snapshot) ||
      (input.flushIntervalMs > 0 && !snapshot)
    ) {
      flush()
      return
    }
    if (frame !== null || batch !== null || snapshot === input.content) return
    const pending = ++revision
    const complete = () => {
      if (pending === revision) flush()
    }
    const scheduleFrame = () => {
      if (pending !== revision || !listeners.size) return
      batch = null
      frame = requestSafeAnimationFrame(complete)
      fallback = setTimeout(complete, 100)
    }
    if (input.flushIntervalMs > 0) batch = setTimeout(scheduleFrame, input.flushIntervalMs)
    else scheduleFrame()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: StreamingInput) {
      teardownRevision++
      listeners.add(listener)
      input = next
      update()
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        const closing = ++teardownRevision
        // Replacing the query within one commit must preserve its existing deadline.
        queueMicrotask(() => {
          if (closing === teardownRevision && !listeners.size) cancel()
        })
      }
    },
  }
}
