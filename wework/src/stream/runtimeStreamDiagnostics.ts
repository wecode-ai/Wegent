import { RESPONSE_API_STREAM_EVENTS } from './responseApiStream'

const RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY = 'wework:debug-runtime-chat-stream'

export function isRuntimeChatStreamDebugEnabled(): boolean {
  if (import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1') return true
  try {
    return globalThis.localStorage?.getItem(RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY) === '1'
  } catch {
    // An unavailable diagnostic preference must not interrupt conversation delivery.
    return false
  }
}

export function setRuntimeChatStreamDebugEnabled(enabled: boolean): void {
  if (enabled) {
    globalThis.localStorage?.setItem(RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY, '1')
    return
  }
  globalThis.localStorage?.removeItem(RUNTIME_CHAT_STREAM_DEBUG_STORAGE_KEY)
}

interface EventTiming {
  count: number
  firstAt: number
  lastAt: number
  elapsedMs: number
  maximumMs: number
}

interface StreamCapture {
  startedAt: number
  finishedAt: number | null
  eventCount: number
  events: Record<string, EventTiming>
  checkpoints: { at: number; eventCount: number }[]
}

const eventNames = new Set<string>(RESPONSE_API_STREAM_EVENTS)
let capture: StreamCapture | null = null

// The E2E bridge enables a bounded timing capture; payloads and identities never enter it.
export function startRuntimeStreamDiagnostics(): void {
  capture = {
    startedAt: Date.now(),
    finishedAt: null,
    eventCount: 0,
    events: {},
    checkpoints: [],
  }
}

export function stopRuntimeStreamDiagnostics(): void {
  if (capture) capture.finishedAt = Date.now()
}

export function getRuntimeStreamDiagnostics(): StreamCapture | null {
  return capture ? structuredClone(capture) : null
}

export function measureRuntimeStreamEvent(
  eventName: string,
  apply: () => void,
  phase: 'native' | 'dispatch' = 'dispatch'
): void {
  const active = capture
  if (!active || active.finishedAt !== null || !eventNames.has(eventName)) {
    apply()
    return
  }
  const at = Date.now()
  const startedAt = performance.now()
  const label = phase === 'native' ? `native:${eventName}` : eventName
  try {
    apply()
  } finally {
    const elapsedMs = performance.now() - startedAt
    const timing = (active.events[label] ??= {
      count: 0,
      firstAt: at,
      lastAt: at,
      elapsedMs: 0,
      maximumMs: 0,
    })
    timing.count++
    timing.lastAt = at
    timing.elapsedMs += elapsedMs
    timing.maximumMs = Math.max(timing.maximumMs, elapsedMs)
    active.eventCount++
    if (
      (active.eventCount === 1 || active.eventCount % 100 === 0) &&
      active.checkpoints.length < 32
    ) {
      active.checkpoints.push({ at, eventCount: active.eventCount })
    }
  }
}
