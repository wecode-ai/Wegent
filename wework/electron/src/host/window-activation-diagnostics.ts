import { randomUUID } from 'node:crypto'

export type WindowActivationInitiator =
  | 'user'
  | 'agent'
  | 'plugin'
  | 'system'
  | 'e2e'
  | 'external_or_user'
  | 'unknown'

export interface WindowActivationEvent {
  reason: string
  initiator: WindowActivationInitiator
  userInitiated: boolean | null
  target?: string
  url?: string
  label?: string
  agentActive?: boolean
  correlationId?: string
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

const TAG = '[window-activation]'
const MAX_URL_LENGTH = 320
const CORRELATION_WINDOW_MS = 5000

let lastActivationRequest: { correlationId: string; requestedAt: number } | null = null

/**
 * Redact a URL for diagnostics: keep protocol, host, path and query key names,
 * replace every query value and the fragment, strip control characters and cap
 * the length so one activation event always stays a single log line.
 */
export function redactUrl(value: string, maxLength = MAX_URL_LENGTH): string {
  const raw = typeof value === 'string' ? value : String(value)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return truncateDiagnosticsText(raw, maxLength)
  }
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.set(key, '*')
  }
  if (parsed.hash) parsed.hash = '#*'
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
 * Record that a programmatic presentation is about to happen and return its
 * correlation id. did-become-active consumes the newest request within the
 * correlation window to attribute the OS-level activation.
 */
export function noteWindowActivationRequest(): string {
  const correlationId = randomUUID()
  lastActivationRequest = { correlationId, requestedAt: Date.now() }
  return correlationId
}

export function takeCorrelatedActivationRequest(): string | null {
  const pending = lastActivationRequest
  lastActivationRequest = null
  if (pending && Date.now() - pending.requestedAt <= CORRELATION_WINDOW_MS) {
    return pending.correlationId
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

export function formatWindowActivationLine(
  event: WindowActivationEvent,
  before: WindowActivationSnapshot,
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
    url: event.url === undefined ? undefined : redactUrl(event.url),
  }
  appendSnapshot(line, before, 'Before')
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
  before: WindowActivationSnapshot,
  after?: WindowActivationSnapshot
): void {
  try {
    console.info(formatWindowActivationLine(event, before, after))
  } catch {
    // Swallow diagnostics failures; the presentation itself already happened.
  }
}
