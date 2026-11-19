import { isRuntimeReadCancellation } from '@/features/workbench/runtimeConversationReadCancellation'
import type { DeviceInfo } from '@/types/api'
import { createRequestId } from '@/lib/request-id'
import { reportE2EDiagnostic, reportE2EError } from '@/e2e/error-capture'
import { recordExecutorActivity, registerExecutorActivity } from '@/e2e/executor-activity'
import { logModelLoading } from '@/lib/model-loading-diagnostics'
import { deliverRuntimeTransport, isRuntimeTransportReplay } from '@/e2e/runtime-transport-gates'

const EXECUTOR_BASE_PATH = '/wework/executor/v1'
registerExecutorActivity()
const executorEventReconnectors = new Set<() => void>()
const executorEventSubscribers = new Map<symbol, (event: DshExecutorEventEnvelope) => void>()
let disconnectExecutorEventStream: (() => void) | null = null
const INITIAL_RECONNECT_DELAY_MS = 500
const MAX_RECONNECT_DELAY_MS = 10_000
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

export async function describeDshExecutor(): Promise<DshExecutorDescription> {
  return observeExecutorRequest('executor.describe', {}, {}, readDshExecutorDescription)
}

function recordResponseBodyFailure(error: unknown, method: string, status: number) {
  // Fetch body consumption rejects with transport errors too; only malformed
  // JSON produces SyntaxError. Keep both failures visible under their own kind.
  const parseFailure = error instanceof SyntaxError
  const stage = parseFailure ? 'body_parse_failed' : 'body_read_failed'
  recordExecutorActivity({ kind: parseFailure ? 'parseFailures' : 'transportFailures' })
  reportE2EDiagnostic('executor-response-body-failure', {
    method,
    stage,
    status,
    errorType: error instanceof Error ? error.name : typeof error,
  })
  return stage
}

async function readDshExecutorDescription(): Promise<DshExecutorDescription> {
  let response: Response
  try {
    response = await fetch(EXECUTOR_BASE_PATH, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    recordExecutorActivity({ kind: 'transportFailures' })
    throw error
  }
  let body: DshExecutorDescribeResponse | DshExecutorErrorBody
  try {
    body = await response.json()
  } catch (error) {
    recordResponseBodyFailure(error, 'executor.describe', response.status)
    throw error
  }
  if (!response.ok) throw transportError(response.status, body as DshExecutorErrorBody)
  if (
    !body ||
    typeof body !== 'object' ||
    !('executor' in body) ||
    !body.executor ||
    typeof body.executor !== 'object'
  ) {
    recordExecutorActivity({ kind: 'protocolFailures' })
    throw new DshExecutorTransportError(
      'protocol_mismatch',
      'DSH executor returned an invalid protocol description'
    )
  }
  if (
    body.protocolVersion !== 1 ||
    body.executor.protocol_version !== 1 ||
    typeof body.executor.device_id !== 'string'
  ) {
    recordExecutorActivity({ kind: 'protocolFailures' })
    throw new DshExecutorTransportError(
      'protocol_mismatch',
      'DSH executor returned an invalid protocol description'
    )
  }
  if (
    typeof body.executor.runtime_instance_id !== 'string' ||
    !body.executor.runtime_instance_id.trim()
  ) {
    recordExecutorActivity({ kind: 'protocolFailures' })
    throw new DshExecutorTransportError(
      'protocol_mismatch',
      'DSH executor returned a missing or invalid Runtime identity'
    )
  }
  return body.executor
}

export async function requestDshExecutor<T>(
  method: string,
  params: Record<string, unknown> = {},
  options: DshExecutorRequestOptions = {}
): Promise<T> {
  return observeExecutorRequest(method, params, options, () =>
    performDshExecutorRequest<T>(method, params, options)
  )
}

async function observeExecutorRequest<T>(
  method: string,
  params: Record<string, unknown>,
  options: DshExecutorRequestOptions,
  request: () => Promise<T>
): Promise<T> {
  recordExecutorActivity({ kind: 'request', method, pendingOnly: params.pendingOnly === true })
  try {
    return await request()
  } catch (error) {
    if (isRuntimeReadCancellation(error, options.signal)) {
      recordExecutorActivity({ kind: 'cancellations' })
      throw error
    }
    recordExecutorActivity({ kind: 'requestFailures' })
    reportE2EError(`executor:${method}`, error)
    throw error
  }
}

async function performDshExecutorRequest<T>(
  method: string,
  params: Record<string, unknown>,
  options: DshExecutorRequestOptions
): Promise<T> {
  const requestId = createRequestId('wework-local')
  const startedAt = Date.now()
  const diagnosticCount = modelDiagnosticCounts.get(method) ?? 0
  const diagnose =
    performance.now() < modelDiagnosticsDeadline &&
    modelDiagnosticMethods.has(method) &&
    diagnosticCount < 3
  if (diagnose) modelDiagnosticCounts.set(method, diagnosticCount + 1)
  const diagnosticStart = performance.now()
  const transportDiagnostic = (stage: string, details: Record<string, unknown> = {}) => {
    console.warn(
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
  console.debug('[Wework] Executor RPC request started', {
    request_id: requestId,
    method,
  })
  const requestBody = JSON.stringify({ id: requestId, method, params })
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
      ...(method === 'runtime.tasks.transcript' && options.signal
        ? { signal: options.signal }
        : {}),
    })
  } catch (error) {
    if (isRuntimeReadCancellation(error, options.signal)) throw error
    recordExecutorActivity({ kind: 'transportFailures' })
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
  console.debug('[Wework] Executor RPC response received', {
    request_id: requestId,
    method,
    elapsed_ms: Date.now() - startedAt,
    status: response.status,
  })
  let parsedBody: unknown
  try {
    parsedBody = await response.json()
  } catch (error) {
    if (isRuntimeReadCancellation(error, options.signal)) throw error
    const stage = recordResponseBodyFailure(error, method, response.status)
    diagnostic(stage)
    transportDiagnostic(stage, {
      status: response.status,
      errorType: error instanceof Error ? error.name : typeof error,
    })
    console.warn(
      stage === 'body_parse_failed'
        ? '[Wework] Executor RPC response parsing failed'
        : '[Wework] Executor RPC response body read failed',
      {
        request_id: requestId,
        method,
        elapsed_ms: Date.now() - startedAt,
        status: response.status,
        error_type: error instanceof Error ? error.name : typeof error,
      }
    )
    throw connectionError(error)
  }
  if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    recordExecutorActivity({ kind: 'protocolFailures' })
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
  return body.result
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
  const subscription = Symbol('executor-event-subscriber')
  executorEventSubscribers.set(subscription, listener)
  if (!disconnectExecutorEventStream) {
    disconnectExecutorEventStream = connectDshExecutorEventStream(event => {
      for (const [id, subscriber] of [...executorEventSubscribers]) {
        if (!executorEventSubscribers.has(id)) continue
        try {
          subscriber(event)
        } catch (error) {
          console.error('[Wework] Executor event listener failed', {
            event: event.event,
            sequence: event.sequence,
            error,
          })
        }
      }
    })
  }
  return () => {
    executorEventSubscribers.delete(subscription)
    if (executorEventSubscribers.size === 0) {
      disconnectExecutorEventStream?.()
      disconnectExecutorEventStream = null
    }
  }
}

// All subscribers in a renderer share one SSE connection, leaving HTTP slots for RPCs.
function connectDshExecutorEventStream(
  listener: (event: DshExecutorEventEnvelope) => void
): () => void {
  let cursor = 0
  const stream = Symbol('executor-stream')
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
    recordExecutorActivity({ kind: 'streamStarts' })
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
        recordExecutorActivity({ kind: 'parseFailures' })
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
        !event ||
        event.protocolVersion !== 1 ||
        !Number.isSafeInteger(event.sequence) ||
        typeof event.event !== 'string'
      ) {
        recordExecutorActivity({ kind: 'protocolFailures' })
        console.error('[Wework] Executor event frame has an invalid envelope')
        nextSource.close()
        source = null
        scheduleReconnect()
        return
      }
      if (event.sequence <= cursor) {
        recordExecutorActivity({
          kind: 'event',
          name: event.event,
          sequence: event.sequence,
          stream,
          delivered: false,
        })
        return
      }
      cursor = event.sequence
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      if (event.event === 'executor.stream.cursor') return
      const deliver = () => {
        recordExecutorActivity({
          kind: 'event',
          name: event.event,
          sequence: event.sequence,
          stream,
          delivered: true,
          injected: isRuntimeTransportReplay(),
        })
        listener(event)
      }
      try {
        if (import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true') {
          deliverRuntimeTransport('event', event.event, event, deliver)
        } else {
          deliver()
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
      recordExecutorActivity({ kind: 'transportFailures' })
      recordExecutorActivity({ kind: 'reconnects' })
      reportE2EError('executor:event-stream', new Error('Executor event stream disconnected'))
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
