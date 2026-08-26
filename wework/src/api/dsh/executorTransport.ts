const EXECUTOR_BASE_PATH = '/wework/executor/v1'
const executorEventReconnectors = new Set<() => void>()

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

  const connect = () => {
    if (closed) return
    const nextSource = new EventSource(
      `${EXECUTOR_BASE_PATH}/events?after=${encodeURIComponent(String(cursor))}`
    )
    source = nextSource
    nextSource.onmessage = message => {
      if (source !== nextSource) return
      const event = JSON.parse(message.data) as DshExecutorEventEnvelope
      if (
        event.protocolVersion !== 1 ||
        !Number.isSafeInteger(event.sequence) ||
        typeof event.event !== 'string'
      ) {
        return
      }
      if (event.sequence <= cursor) return
      listener(event)
      cursor = event.sequence
    }
    nextSource.onerror = () => {
      if (source !== nextSource) return
      nextSource.close()
      source = null
      if (!closed) {
        reconnectTimer = window.setTimeout(connect, 500)
      }
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
