import { gateRuntimeResponse } from '@/e2e/runtime-transport-gates'

export interface DesktopHostErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown>
}

export class DesktopHostError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DesktopHostError'
    this.code = code
    this.details = details
  }
}

export class DesktopHostTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DesktopHostTransportError'
  }
}

export interface DesktopHostEvent {
  sequence: number
  type: string
  payload: Record<string, unknown>
}

interface DesktopHostEventBatch {
  events: DesktopHostEvent[]
  latestSequence: number
  historyLost: boolean
}

type DesktopHostEventHandler = (event: DesktopHostEvent) => void
interface DesktopHostEventSubscriptionOptions {
  readonly replay?: (event: DesktopHostEvent) => boolean
}

const desktopHostEventHandlers = new Set<DesktopHostEventHandler>()
const desktopHostEventHistory: DesktopHostEvent[] = []
const MAX_DESKTOP_HOST_EVENT_HISTORY = 1024
const DESKTOP_HOST_EVENT_CURSOR_KEY = 'wework.desktopHostEventCursor'
const DESKTOP_HOST_EVENT_POLL_INTERVAL_MS = 500
const ATTACHMENT_REQUEST_TIMEOUT_MS = 15_000
let desktopHostEventAfter = loadDesktopHostEventCursor()
let desktopHostEventLoop: Promise<void> | null = null
let desktopHostEventLoopGeneration = 0

export async function invokeDesktopHost<Result>(
  capability: string,
  params: Record<string, unknown> = {}
): Promise<Result> {
  const startedAt = performance.now()
  const e2e = import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true'
  const diagnostic = (phase: string, details: Record<string, number | boolean> = {}) => {
    console.debug(
      '[Wework] Electron host diagnostic ' +
        JSON.stringify({
          capability,
          phase,
          elapsedMs: Math.round(performance.now() - startedAt),
          ...details,
        })
    )
  }
  const pendingDiagnostic = e2e ? setTimeout(() => diagnostic('pending'), 1_000) : undefined
  const attachmentRequest = capability.startsWith('attachment.')
  const abortController = attachmentRequest ? new AbortController() : undefined
  const requestTimeout = abortController
    ? setTimeout(() => abortController.abort(), ATTACHMENT_REQUEST_TIMEOUT_MS)
    : undefined
  try {
    let response: Response
    try {
      response = await fetch('/wework/electron-host/v1/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability, params }),
        ...(abortController ? { signal: abortController.signal } : {}),
      })
    } catch (error) {
      throw new DesktopHostTransportError(
        error instanceof Error ? error.message : 'Electron host request failed',
        { cause: error }
      )
    }
    let body: {
      ok?: boolean
      result?: Result
      error?: DesktopHostErrorPayload
    }
    try {
      body = (await response.json()) as typeof body
    } catch (error) {
      throw new DesktopHostTransportError(
        error instanceof Error ? error.message : 'Electron host response was interrupted',
        { cause: error }
      )
    }
    if (e2e && (capability.startsWith('attachment.') || performance.now() - startedAt >= 1_000)) {
      diagnostic('completed', {
        status: response.status,
        ok: response.ok && body.ok === true,
        ...(capability === 'attachment.append' && typeof params.offset === 'number'
          ? { offset: params.offset }
          : {}),
      })
    }
    if (!response.ok || body.ok !== true) {
      throw new DesktopHostError(
        body.error?.code ?? `http_${response.status}`,
        body.error?.message ?? `Electron host request failed with HTTP ${response.status}`,
        body.error?.details
      )
    }
    const result = body.result as Result
    // E2E barriers delay delivery only after the real Electron operation completes.
    return e2e
      ? gateRuntimeResponse(
          capability,
          params,
          result,
          () => new DesktopHostTransportError('Electron host response was interrupted')
        )
      : result
  } finally {
    if (pendingDiagnostic !== undefined) clearTimeout(pendingDiagnostic)
    if (requestTimeout !== undefined) clearTimeout(requestTimeout)
  }
}

export function subscribeDesktopHostEvents(
  handler: DesktopHostEventHandler,
  options: DesktopHostEventSubscriptionOptions = {}
): () => void {
  desktopHostEventHandlers.add(handler)
  if (options.replay) {
    for (const event of desktopHostEventHistory) {
      if (options.replay(event)) dispatchDesktopHostEvent(handler, event)
    }
  }
  startDesktopHostEventLoop()
  return () => {
    desktopHostEventHandlers.delete(handler)
    if (desktopHostEventHandlers.size === 0) desktopHostEventLoopGeneration += 1
  }
}

export function readDesktopHostEventCursor(): number {
  return desktopHostEventAfter
}

function startDesktopHostEventLoop(): void {
  if (desktopHostEventLoop || desktopHostEventHandlers.size === 0) return
  const generation = ++desktopHostEventLoopGeneration
  desktopHostEventLoop = runDesktopHostEventLoop(generation).finally(() => {
    desktopHostEventLoop = null
    if (desktopHostEventHandlers.size > 0) startDesktopHostEventLoop()
  })
}

async function runDesktopHostEventLoop(generation: number): Promise<void> {
  while (desktopHostEventHandlers.size > 0 && desktopHostEventLoopGeneration === generation) {
    try {
      const batch = await invokeDesktopHost<DesktopHostEventBatch>('desktop.events', {
        after: desktopHostEventAfter,
      })
      if (desktopHostEventLoopGeneration !== generation) return
      if (batch.historyLost) {
        recoverFromDesktopHostEventHistoryLoss(batch.latestSequence)
        return
      }
      desktopHostEventAfter = batch.latestSequence
      for (const event of coalesceDesktopHostEvents(batch.events)) {
        desktopHostEventHistory.push(event)
        if (desktopHostEventHistory.length > MAX_DESKTOP_HOST_EVENT_HISTORY) {
          desktopHostEventHistory.shift()
        }
        desktopHostEventHandlers.forEach(handler => {
          dispatchDesktopHostEvent(handler, event)
        })
      }
      saveDesktopHostEventCursor(desktopHostEventAfter)
      await waitForNextDesktopHostEventPoll()
    } catch (error) {
      if (desktopHostEventLoopGeneration !== generation) return
      console.error('[Wework] Failed to receive Electron host events', error)
      await waitForNextDesktopHostEventPoll()
    }
  }
}

function dispatchDesktopHostEvent(handler: DesktopHostEventHandler, event: DesktopHostEvent): void {
  try {
    handler(event)
  } catch (error) {
    console.error('[Wework] Desktop host event handler failed', error)
  }
}

function recoverFromDesktopHostEventHistoryLoss(latestSequence: number): void {
  console.error('[Wework] Desktop host event history was lost; reloading to resynchronize')
  desktopHostEventAfter = latestSequence
  saveDesktopHostEventCursor(desktopHostEventAfter)
  window.location.reload()
}

function waitForNextDesktopHostEventPoll(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, DESKTOP_HOST_EVENT_POLL_INTERVAL_MS))
}

function coalesceDesktopHostEvents(events: DesktopHostEvent[]): DesktopHostEvent[] {
  const coalescingKeys = new Set<string>()
  const coalescedEvents: DesktopHostEvent[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const key = desktopHostEventCoalescingKey(event)
    if (key && coalescingKeys.has(key)) continue
    if (key) coalescingKeys.add(key)
    coalescedEvents.push(event)
  }
  return coalescedEvents.reverse()
}

function desktopHostEventCoalescingKey(event: DesktopHostEvent): string | null {
  if (event.type !== 'browser.event') return null
  const browserEvent = event.payload as {
    type?: unknown
    payload?: { label?: unknown; nativeLabel?: unknown }
  }
  if (browserEvent.type !== 'page-state') return null
  const label =
    typeof browserEvent.payload?.label === 'string'
      ? browserEvent.payload.label
      : browserEvent.payload?.nativeLabel
  return typeof label === 'string' ? `browser.page-state:${label}` : null
}

function loadDesktopHostEventCursor(): number {
  if (typeof window === 'undefined') return 0
  const parsed = Number(window.sessionStorage.getItem(DESKTOP_HOST_EVENT_CURSOR_KEY))
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function saveDesktopHostEventCursor(cursor: number): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(DESKTOP_HOST_EVENT_CURSOR_KEY, String(cursor))
}
