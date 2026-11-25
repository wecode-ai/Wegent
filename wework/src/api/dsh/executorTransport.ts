import {
  scheduleDshRequest,
  executorRequestPriority,
  dshRpcTimeoutMs,
  type DshRequestPriority,
} from './backgroundRequests'
import type { DeviceInfo } from '@/types/api'
import { createRequestId } from '@/lib/request-id'
import { logModelLoading } from '@/lib/model-loading-diagnostics'
import { deliverRuntimeTransport } from '@/e2e/runtime-transport-gates'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

const EXECUTOR_BASE_PATH = '/wework/executor/v1'
const executorEventReconnectors = new Set<() => void>()
const executorEventSubscribers = new Map<number, (event: DshExecutorEventEnvelope) => void>()
const executorEventSubscriberSources = new Map<number, string[]>()
let lastExecutorEventSubscriber = 0
let disconnectExecutorEventStream: (() => void) | null = null
const INITIAL_RECONNECT_DELAY_MS = 500
const MAX_RECONNECT_DELAY_MS = 10_000
const EVENT_DELIVERY_SLICE_MS = 8
const modelDiagnosticsDeadline = performance.now() + 30_000
const modelDiagnosticMethods = new Set([
  'runtime.tasks.list',
  'runtime.codex.runtime_config.update',
  'runtime.codex.ensure_started',
  'executor.plugins.initialize_bundled_marketplace',
  'runtime.codex.models.list',
])
const modelDiagnosticCounts = new Map<string, number>()

export interface DshExecutorDescription {
  protocol_version: number
  device_id: string
  runtime_instance_id: string
  device_route_id?: string
  version?: string
  capabilities: string[]
  runtime_features?: DeviceInfo['runtime_features']
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

interface PendingExecutorEvent {
  event: DshExecutorEventEnvelope
  throughSubscriber: number
  next?: PendingExecutorEvent
}

interface DshExecutorErrorBody {
  error?: {
    code?: string
    message?: string
    retryable?: boolean
    details?: Record<string, unknown>
  }
}

export interface DshExecutorRequestOptions {
  signal?: AbortSignal
  priority?: DshRequestPriority
}

export class DshExecutorTransportError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    retryable = false,
    details: Record<string, unknown> = {},
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DshExecutorTransportError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export function describeDshExecutor(): Promise<DshExecutorDescription> {
  return readDshExecutorDescription()
}

async function readDshExecutorDescription(): Promise<DshExecutorDescription> {
  const response = await fetch(EXECUTOR_BASE_PATH, {
    // Read live identity without serializing on Chromium HTTP cache entries.
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
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
  if (
    typeof body.executor.runtime_instance_id !== 'string' ||
    !body.executor.runtime_instance_id.trim()
  ) {
    throw new DshExecutorTransportError(
      'protocol_mismatch',
      'DSH executor returned a missing or invalid Runtime identity'
    )
  }
  return body.executor
}

export function requestDshExecutor<T>(
  method: string,
  params: Record<string, unknown> = {},
  options: DshExecutorRequestOptions = {}
): Promise<T> {
  const requestId = createRequestId('wework-local')
  const command = method === 'device.execute_command' ? String(params.command_key ?? '') : undefined
  return scheduleDshRequest(
    options.priority ?? executorRequestPriority(method, params),
    () => performDshExecutorRequest<T>(requestId, method, params, options),
    isCancellableRuntimeRead(method) ? options.signal : undefined,
    undefined,
    { requestId, method, ...(command ? { command } : {}) }
  )
}

async function performDshExecutorRequest<T>(
  requestId: string,
  method: string,
  params: Record<string, unknown> = {},
  options: DshExecutorRequestOptions = {}
): Promise<T> {
  const startedAt = Date.now()
  const diagnosticCount = modelDiagnosticCounts.get(method) ?? 0
  const diagnose =
    performance.now() < modelDiagnosticsDeadline &&
    modelDiagnosticMethods.has(method) &&
    diagnosticCount < 3
  if (diagnose) modelDiagnosticCounts.set(method, diagnosticCount + 1)
  const diagnosticStart = performance.now()
  const transportDiagnostic = (stage: string, details: Record<string, unknown> = {}) => {
    const log = stage === 'dispatch' || stage === 'response_done' ? console.info : console.warn
    log(
      '[Wework] Executor transport diagnostic ' +
        JSON.stringify({
          requestId,
          method,
          stage,
          elapsedMs: Date.now() - startedAt,
          ...details,
        })
    )
  }
  const diagnostic = (stage: string, details: Record<string, number | boolean> = {}) => {
    if (!diagnose) return
    logModelLoading(requestId, `rpc.${method}.${stage}`, {
      elapsedMs: Math.round(performance.now() - diagnosticStart),
      ...details,
    })
  }
  const requestBody = JSON.stringify({ id: requestId, method, params })
  const bodyBytes = new TextEncoder().encode(requestBody).byteLength
  const timeoutFailure = (phase: string) => {
    transportDiagnostic('deadline_exceeded', { phase, bodyBytes })
    return new DshExecutorTransportError(
      'transport_timeout',
      `Executor request ${method} timed out`
    )
  }
  transportDiagnostic('dispatch', { bodyBytes })
  const callerSignal = isCancellableRuntimeRead(method) ? options.signal : undefined
  const deadline = AbortSignal.timeout(dshRpcTimeoutMs(method))
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline
  let response: Response
  try {
    diagnostic('fetch_started')
    if (import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true') {
      await new Promise<void>(resolve =>
        deliverRuntimeTransport('request', method, { params }, resolve)
      )
    }
    response = await fetch(`${EXECUTOR_BASE_PATH}/rpc`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: requestBody,
      signal,
    })
  } catch (error) {
    if (callerSignal?.aborted) throw error
    if (deadline.aborted) throw timeoutFailure('response_headers')
    diagnostic('fetch_failed')
    transportDiagnostic('fetch_failed', {
      errorType: error instanceof Error ? error.name : typeof error,
    })
    console.warn('[Wework] Executor RPC transport failed', {
      request_id: requestId,
      method,
      elapsed_ms: Date.now() - startedAt,
      error,
    })
    throw connectionError(error)
  }
  diagnostic('headers_received', { status: response.status })
  let parsedBody: unknown
  try {
    parsedBody = await response.json()
  } catch (error) {
    if (callerSignal?.aborted) throw error
    if (deadline.aborted) throw timeoutFailure('response_body')
    diagnostic('body_parse_failed')
    transportDiagnostic('body_parse_failed', {
      status: response.status,
      errorType: error instanceof Error ? error.name : typeof error,
    })
    console.warn('[Wework] Executor RPC response parsing failed', {
      request_id: requestId,
      method,
      elapsed_ms: Date.now() - startedAt,
      status: response.status,
      error_type: error instanceof Error ? error.name : typeof error,
    })
    throw connectionError(error)
  }
  if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    throw new DshExecutorTransportError(
      'protocol_mismatch',
      'DSH executor returned an invalid RPC response'
    )
  }
  const body = parsedBody as { ok: true; result: T } | ({ ok?: false } & DshExecutorErrorBody)
  diagnostic('body_parsed', { ok: response.ok && body.ok === true })
  if (!response.ok || body.ok !== true) {
    const error = transportError(response.status, body as DshExecutorErrorBody)
    transportDiagnostic('rpc_failed', { status: response.status, code: error.code })
    console.warn('[Wework] Executor RPC request failed', {
      request_id: requestId,
      method,
      elapsed_ms: Date.now() - startedAt,
      status: response.status,
      code: error.code,
      retryable: error.retryable,
    })
    throw error
  }
  transportDiagnostic('response_done', { status: response.status })
  return body.result
}

function isCancellableRuntimeRead(method: string): boolean {
  return method === 'runtime.tasks.transcript'
}

function connectionError(error: unknown): unknown {
  if (!(error instanceof TypeError)) return error
  return new DshExecutorTransportError(
    'runtime_unavailable',
    error.message,
    true,
    {},
    { cause: error }
  )
}

export function subscribeDshExecutorEvents(
  listener: (event: DshExecutorEventEnvelope) => void
): () => void {
  const subscription = ++lastExecutorEventSubscriber
  executorEventSubscribers.set(subscription, listener)
  const e2e = import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true'
  if (e2e) {
    executorEventSubscriberSources.set(
      subscription,
      [...(new Error().stack ?? '').matchAll(/([^/\s()]+\.js):(\d+):(\d+)/g)]
        .slice(1, 5)
        .map(match => `${match[1]}:${match[2]}:${match[3]}`)
    )
  }
  if (!disconnectExecutorEventStream) {
    disconnectExecutorEventStream = connectDshExecutorEventStream((event, throughSubscriber) => {
      for (const [id, subscriber] of executorEventSubscribers) {
        if (id > throughSubscriber) break
        const startedAt = e2e ? performance.now() : 0
        try {
          subscriber(event)
        } catch (error) {
          console.error('[Wework] Executor event listener failed', {
            event: event.event,
            sequence: event.sequence,
            error,
          })
        } finally {
          const durationMs = e2e ? performance.now() - startedAt : 0
          if (durationMs >= 50)
            logRuntimeTaskCreateStage('executor-slow-event-subscriber', {
              event: event.event,
              sequence: event.sequence,
              durationMs,
              subscriberCount: executorEventSubscribers.size,
              sources: executorEventSubscriberSources.get(id),
            })
        }
      }
    })
  }
  return () => {
    executorEventSubscribers.delete(subscription)
    executorEventSubscriberSources.delete(subscription)
    if (executorEventSubscribers.size === 0) {
      disconnectExecutorEventStream?.()
      disconnectExecutorEventStream = null
    }
  }
}

// All subscribers in a renderer share one SSE connection, leaving HTTP slots for RPCs.
function connectDshExecutorEventStream(
  listener: (event: DshExecutorEventEnvelope, throughSubscriber: number) => void
): () => void {
  let cursor = 0
  let source: EventSource | null = null
  let closed = false
  let reconnectTimer: number | null = null
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
  let connected = false
  // EventSource can dispatch several messages in a browser task, with a
  // microtask checkpoint (and a React commit) after each listener. Deliver
  // bursts together so presentation observes the ordered state once per slice.
  const delivery = new MessageChannel()
  let head: PendingExecutorEvent | undefined
  let tail: PendingExecutorEvent | undefined
  let deliveryScheduled = false
  function scheduleDelivery() {
    if (deliveryScheduled) return
    deliveryScheduled = true
    delivery.port2.postMessage(null)
  }
  delivery.port1.onmessage = () => {
    const startedAt = performance.now()
    const deadline = startedAt + EVENT_DELIVERY_SLICE_MS
    let delivered = 0
    let lastEvent: DshExecutorEventEnvelope | undefined
    let turnUpdate:
      | { status: string; sequence: number; startedAt: number; endedAt: number }
      | undefined
    while (head) {
      const { event, throughSubscriber, next } = head
      head = next
      if (!head) tail = undefined
      const status =
        import.meta.env.VITE_WEWORK_E2E === 'true' && event.event === 'runtime.turn.updated'
          ? (event.payload.data as { status?: unknown } | undefined)?.status
          : undefined
      const turnStartedAt = status === 'started' || status === 'settled' ? performance.now() : 0
      listener(event, throughSubscriber)
      if (status === 'started' || status === 'settled') {
        turnUpdate = {
          status,
          sequence: event.sequence,
          startedAt: turnStartedAt,
          endedAt: performance.now(),
        }
      }
      delivered += 1
      lastEvent = event
      if (performance.now() >= deadline) break
    }
    if (import.meta.env.VITE_WEWORK_E2E === 'true' && lastEvent) {
      const durationMs = performance.now() - startedAt
      if (durationMs >= 50) {
        logRuntimeTaskCreateStage('executor-slow-delivery-slice', {
          durationMs,
          delivered,
          event: lastEvent.event,
          sequence: lastEvent.sequence,
          subscriberCount: executorEventSubscribers.size,
        })
      }
    }
    deliveryScheduled = false
    if (head) scheduleDelivery()
    if (turnUpdate) {
      const turn = turnUpdate
      const sliceEndedAt = performance.now()
      // The renderer budget measures the browser task, including its microtasks.
      // Use the renderer clock so these phases line up with the measured turn.
      queueMicrotask(() => {
        logRuntimeTaskCreateStage('executor-turn-delivery-timing', {
          ...turn,
          delivered,
          sliceStartedAt: startedAt,
          sliceEndedAt,
          microtaskAt: performance.now(),
        })
      })
    }
  }

  function enqueue(event: DshExecutorEventEnvelope, throughSubscriber: number) {
    if (closed) return
    const entry = { event, throughSubscriber }
    if (tail) tail.next = entry
    else head = entry
    tail = entry
    scheduleDelivery()
  }

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
      const parseStartedAt = import.meta.env.VITE_WEWORK_E2E === 'true' ? performance.now() : 0
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
      if (import.meta.env.VITE_WEWORK_E2E === 'true' && performance.now() - parseStartedAt >= 50)
        logRuntimeTaskCreateStage('executor-slow-event-parse', {
          event: event.event,
          sequence: event.sequence,
          durationMs: performance.now() - parseStartedAt,
          bytes: message.data.length,
        })
      cursor = event.sequence
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      if (event.event === 'executor.stream.cursor') return
      const throughSubscriber = lastExecutorEventSubscriber
      try {
        if (import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true') {
          deliverRuntimeTransport('event', event.event, event, () =>
            enqueue(event, throughSubscriber)
          )
        } else {
          enqueue(event, throughSubscriber)
        }
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
    delivery.port1.close()
    delivery.port2.close()
    head = tail = undefined
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
