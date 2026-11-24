import { randomUUID } from 'node:crypto'

export const WINDOW_ACTIVATION_INITIATORS = [
  'user',
  'agent',
  'plugin',
  'system',
  'e2e',
  'external_or_user',
  'unknown',
] as const

export type WindowActivationInitiator = (typeof WINDOW_ACTIVATION_INITIATORS)[number]

export interface WindowActivationEvent {
  reason: string
  initiator: WindowActivationInitiator
  userInitiated: boolean | null
  target?: string
  url?: string
  label?: string
  agentActive?: boolean
  agentStatus?: string
  correlationId?: string
  activationOutcome?: string
  requestedReason?: string
}

export interface WindowActivationSnapshot {
  appActive: boolean
  appHidden: boolean | null
  dockVisible: boolean | null
  focusedWindowId: number | null
  targetId?: number
  targetVisible?: boolean | null
  targetFocused?: boolean | null
}

interface ActivationTargetLike {
  id?: number
  isDestroyed?: () => boolean
  isVisible?: () => boolean
  isFocused?: () => boolean
}

export interface WindowActivationElectron {
  app: {
    isActive(): boolean
    isHidden?(): boolean
    dock?: { isVisible(): boolean } | undefined
  }
  BrowserWindow: { getFocusedWindow(): { id: number } | null }
}

export interface PendingWindowActivationRequest {
  correlationId: string
  requestedAt: number
  reason: string
  initiator: WindowActivationInitiator
  userInitiated: boolean | null
  target?: string
}

const TAG = '[window-activation]'
const MAX_URL_LENGTH = 320
const CORRELATION_WINDOW_MS = 5000

let lastActivationRequest: PendingWindowActivationRequest | null = null

/**
 * Redact a URL for diagnostics: keep protocol, host, path and query key names,
 * replace every query value and the fragment, redact userinfo credentials,
 * redact the opaque requestKey of interaction deep links, strip control
 * characters and cap the length so one activation event always stays a single
 * log line.
 */
export function redactUrl(value: string, maxLength = MAX_URL_LENGTH): string {
  const raw = typeof value === 'string' ? value : String(value)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return truncateDiagnosticsText(raw, maxLength)
  }
  if (parsed.username) parsed.username = 'redacted'
  if (parsed.password) parsed.password = 'redacted'
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.set(key, '*')
  }
  if (parsed.hash) parsed.hash = '#*'
  if (parsed.host === 'interactions' || parsed.pathname.startsWith('/interactions/')) {
    const segments = parsed.pathname.split('/')
    if (segments.length > 3) segments[segments.length - 1] = '*'
    parsed.pathname = segments.join('/')
  }
  return truncateDiagnosticsText(parsed.toString(), maxLength)
}

function truncateDiagnosticsText(value: string, maxLength: number): string {
  // Replace control characters (which would split log lines) with spaces.
  const flattened = Array.from(value)
    .map(character => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127 ? character : ' '
    })
    .join('')
    .trim()
  if (flattened.length <= maxLength) return flattened
  return `${flattened.slice(0, Math.max(0, maxLength - 3))}...`
}

/**
 * Record that a programmatic presentation may activate the app and return its
 * correlation id. Only callers that observed the app inactive beforehand may
 * register a request: did-become-active consumes the newest request within the
 * correlation window to attribute the OS-level activation. Presentations that
 * happened while the app was already active must not register one, otherwise
 * an unrelated user switch within the window would be misattributed.
 */
export function noteWindowActivationRequest(event: {
  reason: string
  initiator: WindowActivationInitiator
  userInitiated: boolean | null
  target?: string
}): string {
  const correlationId = randomUUID()
  lastActivationRequest = { correlationId, requestedAt: Date.now(), ...event }
  return correlationId
}

export function takeCorrelatedActivationRequest(): PendingWindowActivationRequest | null {
  const pending = lastActivationRequest
  lastActivationRequest = null
  if (pending && Date.now() - pending.requestedAt <= CORRELATION_WINDOW_MS) {
    return pending
  }
  return null
}

export function captureWindowActivationSnapshot(
  electron: WindowActivationElectron,
  target?: ActivationTargetLike
): WindowActivationSnapshot {
  const darwin = process.platform === 'darwin'
  const snapshot: WindowActivationSnapshot = {
    appActive: electron.app.isActive(),
    appHidden: darwin ? (electron.app.isHidden?.() ?? null) : null,
    dockVisible: darwin ? (electron.app.dock?.isVisible() ?? null) : null,
    focusedWindowId: electron.BrowserWindow.getFocusedWindow()?.id ?? null,
  }
  if (target && !target.isDestroyed?.()) {
    snapshot.targetId = target.id
    snapshot.targetVisible = target.isVisible?.() ?? null
    snapshot.targetFocused = target.isFocused?.() ?? null
  }
  return snapshot
}

/** Snapshot variant that never throws; undefined means "unknown state". */
export function captureWindowActivationSnapshotSafe(
  electron: WindowActivationElectron,
  target?: ActivationTargetLike
): WindowActivationSnapshot | undefined {
  try {
    return captureWindowActivationSnapshot(electron, target)
  } catch {
    return undefined
  }
}

export function formatWindowActivationLine(
  event: WindowActivationEvent,
  before?: WindowActivationSnapshot,
  after?: WindowActivationSnapshot
): string {
  const line: Record<string, unknown> = {
    reason: event.reason,
    initiator: event.initiator,
    userInitiated: event.userInitiated,
    target: event.target,
    label: event.label,
    agentActive: event.agentActive,
    correlationId: event.correlationId,
    activationOutcome: event.activationOutcome,
    requestedReason: event.requestedReason,
    url: event.url === undefined ? undefined : redactUrl(event.url),
  }
  if (before) appendSnapshot(line, before, 'Before')
  if (after) appendSnapshot(line, after, 'After')
  return `${TAG} ${JSON.stringify(line)}`
}

function appendSnapshot(
  line: Record<string, unknown>,
  snapshot: WindowActivationSnapshot,
  suffix: string
): void {
  for (const [key, value] of Object.entries(snapshot)) {
    line[`${key}${suffix}`] = value
  }
}

/**
 * Emit one activation diagnostic line. Formatting and redaction failures must
 * never break the presentation that produced the event.
 */
export function logWindowActivation(
  event: WindowActivationEvent,
  before?: WindowActivationSnapshot,
  after?: WindowActivationSnapshot
): void {
  try {
    console.info(formatWindowActivationLine(event, before, after))
  } catch {
    // Swallow diagnostics failures; the presentation itself already happened.
  }
}

/**
 * Capture-and-log convenience for direct entry points. The snapshot capture is
 * part of the safety boundary: a throwing Electron accessor must not break the
 * caller.
 */
export function logWindowActivationForElectron(
  event: WindowActivationEvent,
  electron: WindowActivationElectron,
  target?: ActivationTargetLike
): void {
  try {
    logWindowActivation(event, captureWindowActivationSnapshot(electron, target))
  } catch {
    // Swallow diagnostics failures; the caller's action must proceed.
  }
}
