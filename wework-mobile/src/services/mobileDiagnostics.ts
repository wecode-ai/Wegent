let enabled = false
let preferencePending = true
const startupRecords: Array<Record<string, unknown>> = []
const appStartedAt = Date.now()
const listeners = new Set<() => void>()

export const diagnosticsEnabled = () => enabled
export function subscribeDiagnostics(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setDiagnosticRecording(value: boolean): void {
  preferencePending = false
  const pending = startupRecords.splice(0)
  if (value) pending.forEach(record => console.info('[MobileLifecycle]', record))
  if (enabled === value) return
  enabled = value
  listeners.forEach(listener => listener())
}

/** Callers supply fixed event names and metadata, never message bodies or credentials. */
export function recordMobileDiagnostic(event: string, details?: unknown | (() => unknown)): void {
  if (!enabled) return
  console.info(event, typeof details === 'function' ? details() : details)
}

// External transport errors may contain request URLs or credentials. Record only their boundary.
export const mobileSocketLogger = {
  info: () => recordMobileDiagnostic('[Socket.IO] Connection lifecycle'),
  error: () => recordMobileDiagnostic('[Socket.IO] Connection failure'),
}

export function recordMobileDiagnosticFailure(event: string, cause: unknown): void {
  recordMobileDiagnostic(event, () => ({
    errorType: cause instanceof Error ? cause.name : typeof cause,
  }))
}

type LifecycleOperation =
  | 'app-mount'
  | 'diagnostic-preference'
  | 'auth-restore'
  | 'backend-connection'
  | 'phone-bootstrap'
  | 'phone-profile'
  | 'phone-initialize'
  | 'phone-start'
  | 'work-list'
  | 'work-publish'
  | 'cache-hydration'
  | 'cache-read'
  | 'cloud-devices'
  | 'cloud-models'
  | 'device-models'
  | 'conversation-list'

let nextLifecycleId = 1

/** Only fixed stages and numeric counters cross this boundary, never runtime payloads. */
export function beginMobileDiagnostic(operation: LifecycleOperation, target?: 'phone' | 'cloud') {
  const span = nextLifecycleId++
  const startedAt = Date.now()
  let finished = false
  const record = (phase: string, details?: Record<string, string | number>) => {
    if (!enabled && !preferencePending) return
    const entry = {
      operation,
      target,
      span,
      phase,
      elapsedMs: Date.now() - startedAt,
      sinceAppStartMs: Date.now() - appStartedAt,
      ...details,
    }
    if (enabled) console.info('[MobileLifecycle]', entry)
    else {
      // Retain only bounded, fixed lifecycle metadata until the stored opt-in is known.
      if (startupRecords.length === 128) startupRecords.shift()
      startupRecords.push(entry)
    }
  }
  const finish = (phase: string, details?: Record<string, string | number>) => {
    if (finished) return
    finished = true
    record(phase, details)
  }
  record('start')
  return {
    step: (stage: string, counts?: Record<string, number>) => {
      if (!finished) record('progress', { stage, ...counts })
    },
    complete: (counts?: Record<string, number>) => finish('complete', counts),
    fail: (cause: unknown) =>
      finish('failed', { errorType: cause instanceof Error ? cause.name : typeof cause }),
    cancel: () => finish('cancelled'),
  }
}
