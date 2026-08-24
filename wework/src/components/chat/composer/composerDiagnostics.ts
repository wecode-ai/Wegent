const MAX_EVENTS = 500
const MAX_STRING_LENGTH = 80

const SAFE_DETAIL_KEYS = new Set([
  'altKey',
  'code',
  'composerId',
  'ctrlKey',
  'dataKind',
  'dataLength',
  'docChanged',
  'draftLength',
  'elapsedMs',
  'eventIsComposing',
  'eventCount',
  'external',
  'frameDelayMs',
  'inputType',
  'key',
  'metaKey',
  'reason',
  'selectionEnd',
  'selectionStart',
  'shiftKey',
  'shouldSetComposer',
  'sourceValueLength',
  'transactionMs',
  'valueLength',
  'viewIsComposing',
])

export type ComposerDiagnosticEventName =
  | 'before-input'
  | 'composition-end'
  | 'composition-start'
  | 'draft-external-sync'
  | 'draft-flush'
  | 'draft-flush-request'
  | 'editor-mounted'
  | 'editor-unmounted'
  | 'external-value-apply'
  | 'input-frame'
  | 'keyboard'
  | 'transaction'
  | 'value-set'

export interface ComposerDiagnosticEvent {
  sequence: number
  timestampUnixMs: number
  elapsedMs: number
  name: ComposerDiagnosticEventName
  details: Record<string, boolean | number | string | null>
}

export interface ComposerDiagnosticsSnapshot {
  schemaVersion: 1
  capturedAtUnixMs: number
  sessionStartedAtUnixMs: number
  droppedEventCount: number
  events: ComposerDiagnosticEvent[]
}

let nextComposerId = 1
let nextSequence = 1
let droppedEventCount = 0
let sessionStartedAtUnixMs = Date.now()
let sessionStartedAt = performance.now()
const events: ComposerDiagnosticEvent[] = []
let nextEventIndex = 0

export function allocateComposerDiagnosticId(): number {
  const id = nextComposerId
  nextComposerId += 1
  return id
}

export function recordComposerDiagnostic(
  name: ComposerDiagnosticEventName,
  details: Record<string, unknown> = {}
): void {
  const event = {
    sequence: nextSequence,
    timestampUnixMs: Date.now(),
    elapsedMs: roundDuration(performance.now() - sessionStartedAt),
    name,
    details: sanitizeDetails(details),
  }
  nextSequence += 1

  if (events.length < MAX_EVENTS) {
    events.push(event)
    return
  }
  events[nextEventIndex] = event
  nextEventIndex = (nextEventIndex + 1) % MAX_EVENTS
  droppedEventCount += 1
}

export function getComposerDiagnosticsSnapshot(): ComposerDiagnosticsSnapshot | null {
  if (events.length === 0) return null
  return {
    schemaVersion: 1,
    capturedAtUnixMs: Date.now(),
    sessionStartedAtUnixMs,
    droppedEventCount,
    events: orderedEvents().map(event => ({ ...event, details: { ...event.details } })),
  }
}

export function classifyComposerInputData(data: string | null): {
  dataLength: number
  dataKind: 'absent' | 'ascii-letters' | 'ascii-other' | 'non-ascii'
} {
  if (data === null) return { dataLength: 0, dataKind: 'absent' }
  if (/^[a-z]+$/i.test(data)) return { dataLength: data.length, dataKind: 'ascii-letters' }
  if (Array.from(data).every(character => character.charCodeAt(0) <= 127)) {
    return { dataLength: data.length, dataKind: 'ascii-other' }
  }
  return { dataLength: data.length, dataKind: 'non-ascii' }
}

export function diagnosticKeyboardKey(key: string): string | null {
  if (key.length === 1) return null
  return [
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'Backspace',
    'Delete',
    'Enter',
    'Escape',
    'Tab',
  ].includes(key)
    ? key
    : 'other'
}

export function roundComposerDuration(value: number): number {
  return roundDuration(value)
}

export function resetComposerDiagnosticsForTest(): void {
  events.splice(0)
  nextComposerId = 1
  nextSequence = 1
  droppedEventCount = 0
  nextEventIndex = 0
  sessionStartedAtUnixMs = Date.now()
  sessionStartedAt = performance.now()
}

function orderedEvents(): ComposerDiagnosticEvent[] {
  if (events.length < MAX_EVENTS || nextEventIndex === 0) return events
  return [...events.slice(nextEventIndex), ...events.slice(0, nextEventIndex)]
}

function sanitizeDetails(
  details: Record<string, unknown>
): Record<string, boolean | number | string | null> {
  const sanitized: Record<string, boolean | number | string | null> = {}
  Object.entries(details).forEach(([key, value]) => {
    if (!SAFE_DETAIL_KEYS.has(key)) return
    if (value === null || typeof value === 'boolean') {
      sanitized[key] = value
      return
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = roundDuration(value)
      return
    }
    if (typeof value === 'string') {
      sanitized[key] = value.slice(0, MAX_STRING_LENGTH)
    }
  })
  return sanitized
}

function roundDuration(value: number): number {
  return Math.round(value * 10) / 10
}
