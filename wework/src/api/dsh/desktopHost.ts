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

const desktopHostEventHandlers = new Set<DesktopHostEventHandler>()
const DESKTOP_HOST_EVENT_CURSOR_KEY = 'wework.desktopHostEventCursor'
const DESKTOP_HOST_EVENT_POLL_INTERVAL_MS = 500
let desktopHostEventAfter = loadDesktopHostEventCursor()
let desktopHostEventLoop: Promise<void> | null = null
let desktopHostEventLoopGeneration = 0

export async function invokeDesktopHost<Result>(
  capability: string,
  params: Record<string, unknown> = {}
): Promise<Result> {
  const response = await fetch('/wework/electron-host/v1/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, params }),
  })
  const body = (await response.json()) as {
    ok?: boolean
    result?: Result
    error?: DesktopHostErrorPayload
  }
  if (!response.ok || body.ok !== true) {
    throw new DesktopHostError(
      body.error?.code ?? `http_${response.status}`,
      body.error?.message ?? `Electron host request failed with HTTP ${response.status}`,
      body.error?.details
    )
  }
  return body.result as Result
}

export function subscribeDesktopHostEvents(handler: DesktopHostEventHandler): () => void {
  desktopHostEventHandlers.add(handler)
  startDesktopHostEventLoop()
  return () => {
    desktopHostEventHandlers.delete(handler)
    if (desktopHostEventHandlers.size === 0) desktopHostEventLoopGeneration += 1
  }
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
        desktopHostEventHandlers.forEach(handler => {
          try {
            handler(event)
          } catch (error) {
            console.error('[Wework] Desktop host event handler failed', error)
          }
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
