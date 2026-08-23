const TERMINAL_BASE_PATH = '/wework/terminal/v1'

let terminalEventSuspensionDepth = 0
let suspendedTerminalEventDeliveries: Array<() => void> = []

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
  let cursor = 0
  let source: EventSource | null = null
  let closed = false
  let reconnectTimer: number | null = null

  const connect = () => {
    if (closed) return
    source = new EventSource(
      `${TERMINAL_BASE_PATH}/events?after=${encodeURIComponent(String(cursor))}`
    )
    source.onmessage = message => {
      const event = JSON.parse(message.data) as DshTerminalEventEnvelope
      if (
        event.protocolVersion !== 1 ||
        !Number.isSafeInteger(event.sequence) ||
        typeof event.event !== 'string'
      ) {
        return
      }
      cursor = Math.max(cursor, event.sequence)
      const deliver = () => {
        if (!closed) listener(event)
      }
      if (terminalEventSuspensionDepth > 0) {
        suspendedTerminalEventDeliveries.push(deliver)
      } else {
        deliver()
      }
    }
    source.onerror = () => {
      source?.close()
      source = null
      if (!closed) reconnectTimer = window.setTimeout(connect, 500)
    }
  }

  connect()
  return () => {
    closed = true
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    source?.close()
    source = null
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

function transportError(status: number, body: DshTerminalErrorBody): DshTerminalTransportError {
  return new DshTerminalTransportError(
    body.error?.code ?? `http_${status}`,
    body.error?.message ?? `DSH terminal request failed with HTTP ${status}`,
    body.error?.retryable ?? status >= 500
  )
}
