const EXECUTOR_BASE_PATH = '/wework/executor/v1'

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
  let pendingTextDelta: DshExecutorEventEnvelope | null = null
  let pendingTextDeltaFrame: number | null = null

  const cancelPendingTextDeltaFrame = () => {
    if (pendingTextDeltaFrame === null) return
    window.cancelAnimationFrame(pendingTextDeltaFrame)
    pendingTextDeltaFrame = null
  }

  const flushPendingTextDelta = () => {
    cancelPendingTextDeltaFrame()
    const event = pendingTextDelta
    pendingTextDelta = null
    if (event) listener(event)
  }

  const schedulePendingTextDelta = () => {
    if (pendingTextDeltaFrame !== null) return
    pendingTextDeltaFrame = window.requestAnimationFrame(() => {
      pendingTextDeltaFrame = null
      const event = pendingTextDelta
      pendingTextDelta = null
      if (event) listener(event)
    })
  }

  const deliver = (event: DshExecutorEventEnvelope) => {
    if (event.event !== 'response.output_text.delta') {
      flushPendingTextDelta()
      listener(event)
      return
    }

    if (pendingTextDelta && mergeTextDeltaEvents(pendingTextDelta, event)) {
      return
    }
    flushPendingTextDelta()
    pendingTextDelta = cloneTextDeltaEvent(event)
    schedulePendingTextDelta()
  }

  const connect = () => {
    if (closed) return
    source = new EventSource(
      `${EXECUTOR_BASE_PATH}/events?after=${encodeURIComponent(String(cursor))}`
    )
    source.onmessage = message => {
      const event = JSON.parse(message.data) as DshExecutorEventEnvelope
      if (
        event.protocolVersion !== 1 ||
        !Number.isSafeInteger(event.sequence) ||
        typeof event.event !== 'string'
      ) {
        return
      }
      cursor = Math.max(cursor, event.sequence)
      deliver(event)
    }
    source.onerror = () => {
      flushPendingTextDelta()
      source?.close()
      source = null
      if (!closed) {
        reconnectTimer = window.setTimeout(connect, 500)
      }
    }
  }

  connect()
  return () => {
    closed = true
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    cancelPendingTextDeltaFrame()
    pendingTextDelta = null
    source?.close()
    source = null
  }
}

function cloneTextDeltaEvent(event: DshExecutorEventEnvelope): DshExecutorEventEnvelope {
  return {
    ...event,
    payload: {
      ...event.payload,
      data: {
        ...eventData(event),
      },
    },
  }
}

function mergeTextDeltaEvents(
  pending: DshExecutorEventEnvelope,
  next: DshExecutorEventEnvelope
): boolean {
  const pendingData = eventData(pending)
  const nextData = eventData(next)
  const pendingDelta = pendingData.delta
  const nextDelta = nextData.delta
  if (typeof pendingDelta !== 'string' || typeof nextDelta !== 'string') return false
  if (textDeltaIdentity(pending) !== textDeltaIdentity(next)) return false

  const pendingOffset = pendingData.offset
  const nextOffset = nextData.offset
  if (
    typeof pendingOffset === 'number' &&
    typeof nextOffset === 'number' &&
    nextOffset !== pendingOffset + pendingDelta.length
  ) {
    return false
  }
  if ((typeof pendingOffset === 'number') !== (typeof nextOffset === 'number')) {
    return false
  }

  pending.sequence = next.sequence
  pending.emittedAt = next.emittedAt
  pendingData.delta = pendingDelta + nextDelta
  return true
}

function textDeltaIdentity(event: DshExecutorEventEnvelope): string {
  const payload = { ...event.payload }
  delete payload.data
  const data = { ...eventData(event) }
  delete data.delta
  delete data.offset
  return JSON.stringify([payload, data])
}

function eventData(event: DshExecutorEventEnvelope): Record<string, unknown> {
  const data = event.payload.data
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {}
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
