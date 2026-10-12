import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from './runtime-environment'

let sequence = 0
let persistenceWarningLogged = false
let flushTimer: ReturnType<typeof setTimeout> | undefined
let flushing = false
const pendingEvents: Array<Record<string, unknown>> = []
const FLUSH_INTERVAL_MS = 10_000
const MAX_PENDING_EVENTS = 200

function scheduleFlush(): void {
  if (flushTimer || flushing || pendingEvents.length === 0) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void flushDiagnostics()
  }, FLUSH_INTERVAL_MS)
}

async function flushDiagnostics(): Promise<void> {
  if (flushing || pendingEvents.length === 0) return
  flushing = true
  const events = pendingEvents.splice(0, MAX_PENDING_EVENTS)
  try {
    await invokeDesktopHost('diagnostics.modelLoading', { events })
  } catch {
    if (!persistenceWarningLogged) {
      persistenceWarningLogged = true
      console.warn('[Wework][model-loading] persistent diagnostics unavailable')
    }
  } finally {
    flushing = false
    scheduleFlush()
  }
}

export function createModelLoadingTrace(): string {
  return `models-${Date.now().toString(36)}-${++sequence}`
}

export function logModelLoading(
  traceId: string,
  stage: string,
  details: Record<string, number | boolean> = {}
): void {
  const event = { traceId, stage, timestampMs: Date.now(), ...details }
  if (!isElectronRuntime()) return
  if (pendingEvents.length === MAX_PENDING_EVENTS) pendingEvents.shift()
  pendingEvents.push(event)
  scheduleFlush()
}

export function observeModelLoadingMainThread(traceId: string): () => void {
  const started = performance.now()
  let expectedAt = started + 100
  let maxLagMs = 0
  let delayedSamples = 0
  const timer = setInterval(() => {
    const now = performance.now()
    const lagMs = Math.max(0, now - expectedAt)
    expectedAt = now + 100
    maxLagMs = Math.max(maxLagMs, lagMs)
    if (lagMs < 100) return
    delayedSamples += 1
    logModelLoading(traceId, 'renderer.event_loop_delay', {
      lagMs: Math.round(lagMs),
      hidden: document.hidden,
    })
  }, 100)
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    clearTimeout(deadline)
    logModelLoading(traceId, 'renderer.observation_finished', {
      elapsedMs: Math.round(performance.now() - started),
      maxLagMs: Math.round(maxLagMs),
      delayedSamples,
    })
  }
  const deadline = setTimeout(stop, 30_000)
  return stop
}

export async function traceModelLoading<T>(
  traceId: string,
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  const started = performance.now()
  logModelLoading(traceId, `${stage}.started`)
  try {
    const result = await operation()
    logModelLoading(traceId, `${stage}.finished`, {
      elapsedMs: Math.round(performance.now() - started),
    })
    return result
  } catch (error) {
    logModelLoading(traceId, `${stage}.failed`, {
      elapsedMs: Math.round(performance.now() - started),
    })
    throw error
  }
}
