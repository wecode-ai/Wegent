const EXECUTOR_BASE_PATH = '/wework/executor/v1'
const executorEventReconnectors = new Set<() => void>()
const INITIAL_RECONNECT_DELAY_MS = 500
const MAX_RECONNECT_DELAY_MS = 10_000

export interface DshExecutorDescription {
  protocol_version: number
  device_id: string
  runtime_instance_id?: string
  version?: string
  capabilities: string[]
  renderer_methods: string[]
  transports: string[]
}

interface DshExecutorDescribeResponse {
  protocolVersion: number
  transport: string
  executor: DshExecutorDescription
}

interface DshExecutorEventEnvelope {
  protocolVersion: number
  sequence: number
  emittedAt: string
  event: string
  payload: Record<string, unknown>
}

interface DshExecutorErrorBody {
  error?: {
    code?: string
    message?: string
    retryable?: boolean
    details?: Record<string, unknown>
  }
}

export class DshExecutorTransportError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    retryable = false,
    details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'DshExecutorTransportError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export async function describeDshExecutor(): Promise<DshExecutorDescription> {
  const response = await fetch(EXECUTOR_BASE_PATH, {
    headers: { accept: 'application/json' },
  })
  const body = (await response.json()) as DshExecutorDescribeResponse | DshExecutorErrorBody
  if (!response.ok || !('executor' in body)) {
    throw transportError(response.status, body as DshExecutorErrorBody)
  }
  if (
    body.protocolVersion !== 1 ||
    body.executor.protocol_version !== 1 ||
    typeof body.executor.device_id !== 'string'
  ) {
    throw new DshExecutorTransportError(
      'protocol_mismatch',
      'DSH executor returned an invalid protocol description'
    )
  }
  return body.executor
}

export async function requestDshExecutor<T>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(`${EXECUTOR_BASE_PATH}/rpc`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ method, params }),
  })
  const body = (await response.json()) as
    | { ok: true; result: T }
    | ({ ok?: false } & DshExecutorErrorBody)
  if (!response.ok || body.ok !== true) {
    throw transportError(response.status, body as DshExecutorErrorBody)
  }
  return body.result
}

export function subscribeDshExecutorEvents(
  listener: (event: DshExecutorEventEnvelope) => void
): () => void {
  let cursor = 0
  let source: EventSource | null = null
  let closed = false
  let reconnectTimer: number | null = null
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
  let connected = false

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return
    const delay = reconnectDelayMs
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  const connect = () => {
    if (closed) return
    const nextSource = new EventSource(
      `${EXECUTOR_BASE_PATH}/events?after=${encodeURIComponent(String(cursor))}&replay=${
        connected ? '1' : '0'
      }`
    )
    source = nextSource
    nextSource.onopen = () => {
      if (source === nextSource) connected = true
    }
    nextSource.onmessage = message => {
      if (source !== nextSource) return
      let event: DshExecutorEventEnvelope
      try {
        event = JSON.parse(message.data) as DshExecutorEventEnvelope
      } catch (error) {
        console.error('[Wework] Executor event frame is not valid JSON', {
          bytes: message.data.length,
          error,
        })
        nextSource.close()
        source = null
        scheduleReconnect()
        return
      }
      if (
        event.protocolVersion !== 1 ||
        !Number.isSafeInteger(event.sequence) ||
        typeof event.event !== 'string'
      ) {
        console.error('[Wework] Executor event frame has an invalid envelope')
        nextSource.close()
        source = null
        scheduleReconnect()
        return
      }
      if (event.sequence <= cursor) return
      cursor = event.sequence
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      if (event.event === 'executor.stream.cursor') return
      try {
        listener(event)
      } catch (error) {
        console.error('[Wework] Executor event listener failed', {
          event: event.event,
          sequence: event.sequence,
          error,
        })
      }
    }
    nextSource.onerror = () => {
      if (source !== nextSource) return
      nextSource.close()
      source = null
      scheduleReconnect()
    }
  }

  const reconnect = () => {
    if (closed) return
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    source?.close()
    source = null
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
    connect()
  }

  executorEventReconnectors.add(reconnect)
  connect()
  return () => {
    closed = true
    executorEventReconnectors.delete(reconnect)
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    source?.close()
    source = null
  }
}

export function reconnectDshExecutorEvents(): void {
  executorEventReconnectors.forEach(reconnect => reconnect())
}

function transportError(status: number, body: DshExecutorErrorBody): DshExecutorTransportError {
  const error = body.error
  return new DshExecutorTransportError(
    error?.code ?? `http_${status}`,
    error?.message ?? `DSH executor request failed with HTTP ${status}`,
    error?.retryable ?? status >= 500,
    error?.details ?? {}
  )
}
