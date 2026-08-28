const TERMINAL_BASE_PATH = '/wework/terminal/v1'

let terminalEventSuspensionDepth = 0
let suspendedTerminalEventDeliveries: Array<() => void> = []
let terminalEventCursor = 0
let terminalEventSource: EventSource | null = null
let terminalEventReconnectTimer: number | null = null
const terminalEventListeners = new Set<(event: DshTerminalEventEnvelope) => void>()

export interface DshTerminalEventEnvelope {
  protocolVersion: number
  sequence: number
  emittedAt: string
  event: string
  payload: Record<string, unknown>
}

interface DshTerminalErrorBody {
  error?: {
    code?: string
    message?: string
    retryable?: boolean
  }
}

export class DshTerminalTransportError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'DshTerminalTransportError'
    this.code = code
    this.retryable = retryable
  }
}

export async function requestDshTerminal<T>(
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${TERMINAL_BASE_PATH}/rpc`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ method, params }),
  })
  const body = (await response.json()) as
    | { ok: true; result: T }
    | ({ ok?: false } & DshTerminalErrorBody)
  if (!response.ok || body.ok !== true) {
    throw transportError(response.status, body as DshTerminalErrorBody)
  }
  return body.result
}

export function subscribeDshTerminalEvents(
  listener: (event: DshTerminalEventEnvelope) => void
): () => void {
  terminalEventListeners.add(listener)
  connectDshTerminalEventSource()
  let closed = false
  return () => {
    if (closed) return
    closed = true
    terminalEventListeners.delete(listener)
    if (terminalEventListeners.size > 0) return
    if (terminalEventReconnectTimer !== null) {
      window.clearTimeout(terminalEventReconnectTimer)
      terminalEventReconnectTimer = null
    }
    terminalEventSource?.close()
    terminalEventSource = null
  }
}

function connectDshTerminalEventSource(): void {
  if (terminalEventSource || terminalEventListeners.size === 0) return
  terminalEventSource = new EventSource(
    `${TERMINAL_BASE_PATH}/events?after=${encodeURIComponent(String(terminalEventCursor))}`
  )
  terminalEventSource.onmessage = message => {
    const event = JSON.parse(message.data) as DshTerminalEventEnvelope
    if (
      event.protocolVersion !== 1 ||
      !Number.isSafeInteger(event.sequence) ||
      typeof event.event !== 'string'
    ) {
      return
    }
    terminalEventCursor = Math.max(terminalEventCursor, event.sequence)
    const deliver = () => {
      terminalEventListeners.forEach(activeListener => activeListener(event))
    }
    if (terminalEventSuspensionDepth > 0) {
      suspendedTerminalEventDeliveries.push(deliver)
    } else {
      deliver()
    }
  }
  terminalEventSource.onerror = () => {
    terminalEventSource?.close()
    terminalEventSource = null
    if (terminalEventListeners.size > 0) {
      terminalEventReconnectTimer = window.setTimeout(() => {
        terminalEventReconnectTimer = null
        connectDshTerminalEventSource()
      }, 500)
    }
  }
}

export function suspendDshTerminalEventDelivery(): () => void {
  terminalEventSuspensionDepth += 1
  let resumed = false
  return () => {
    if (resumed) return
    resumed = true
    terminalEventSuspensionDepth = Math.max(0, terminalEventSuspensionDepth - 1)
    if (terminalEventSuspensionDepth > 0) return
    const deliveries = suspendedTerminalEventDeliveries
    suspendedTerminalEventDeliveries = []
    deliveries.forEach(deliver => deliver())
  }
}

export function resetDshTerminalTransportForTests(): void {
  if (!import.meta.env.MODE.includes('test')) return
  terminalEventSource?.close()
  terminalEventSource = null
  if (terminalEventReconnectTimer !== null) {
    window.clearTimeout(terminalEventReconnectTimer)
    terminalEventReconnectTimer = null
  }
  terminalEventListeners.clear()
  terminalEventCursor = 0
  terminalEventSuspensionDepth = 0
  suspendedTerminalEventDeliveries = []
}

function transportError(status: number, body: DshTerminalErrorBody): DshTerminalTransportError {
  return new DshTerminalTransportError(
    body.error?.code ?? `http_${status}`,
    body.error?.message ?? `DSH terminal request failed with HTTP ${status}`,
    body.error?.retryable ?? status >= 500
  )
}
