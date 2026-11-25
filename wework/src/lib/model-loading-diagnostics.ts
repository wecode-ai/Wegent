import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from './runtime-environment'
import { logRuntimeTaskCreateStage } from './runtime-create-diagnostics'

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
  if (
    (import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true') &&
    stage.startsWith('workbench.')
  ) {
    logRuntimeTaskCreateStage('e2e-model-selection', {
      traceId,
      modelLoadingStage: stage,
      timestampMs: event.timestampMs,
      ...details,
    })
  }
  if (!isElectronRuntime()) return
  if (pendingEvents.length === MAX_PENDING_EVENTS) pendingEvents.shift()
  pendingEvents.push(event)
  scheduleFlush()
}

export function observeModelLoadingMainThread(traceId: string): () => void {
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('longtask')
  )
    return () => {}
  const started = performance.now()
  const report = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.duration < 100) continue
      logModelLoading(traceId, 'renderer.long_task', {
        durationMs: Math.round(entry.duration),
        elapsedMs: Math.round(entry.startTime - started),
        hidden: document.hidden,
      })
    }
  }
  const observer = new PerformanceObserver(list => report(list.getEntries()))
  observer.observe({ type: 'longtask' })
  const disconnect = () => {
    report(observer.takeRecords())
    observer.disconnect()
  }
  const deadline = setTimeout(disconnect, 30_000)
  return () => {
    clearTimeout(deadline)
    disconnect()
  }
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
