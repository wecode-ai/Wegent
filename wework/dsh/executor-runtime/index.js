import { randomUUID } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ExecutorRuntimeClient, ExecutorRuntimeError } from './executor-runtime-client.js'
import { LocalEndpointEventByteStream } from './local-endpoint-event-stream.js'
import { ExecutorSessionProjector } from './session-projector.js'
import { ExecutorSessionProjectionStream } from './session-projection-stream.js'
import { TranscriptSource } from './transcript-source.js'

export const name = 'wework-executor-runtime'
export const inject = ['webServer', 'sessions']

const BASE_PATH = '/wework/executor/v1'
const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const MAX_EVENT_FRAME_BYTES = 16 * 1024 * 1024
const SLOW_CONSUMER_TIMEOUT_MS = 30_000

export async function apply(ctx) {
  const client = ExecutorRuntimeClient.fromEnvironment()
  await client.start()
  ctx.effect(() => () => client.stop(), 'wework-executor-runtime: transport')
  const transcriptSource = new TranscriptSource({
    onError: error => {
      console.error('[wework-executor-runtime] transcript subscriber failed', error)
    },
    readTurn: turn => readExecutorTurn(client, turn),
  })
  const projector = new ExecutorSessionProjector(ctx.sessions, {
    onTurnCompleted: turn => transcriptSource.publish(turn),
  })
  ctx.effect(
    () => ctx.reflect.provide('weworkTranscriptSource', transcriptSource),
    'wework-executor-runtime: transcript source'
  )
  const transcriptTarget = createTranscriptTarget(client)
  ctx.effect(
    () => ctx.reflect.provide('weworkTranscriptTarget', transcriptTarget),
    'wework-executor-runtime: transcript target'
  )
  const projectionStream = new ExecutorSessionProjectionStream(projector, {
    onError: error => {
      console.error('[wework-executor-runtime] DSH session projection failed', error)
    },
  })
  ctx.effect(() => {
    projectionStream.start()
    return () => projectionStream.stop()
  }, 'wework-executor-runtime: session projection')
  register(ctx, BASE_PATH, (req, res) => describe(req, res, client))
  register(ctx, `${BASE_PATH}/rpc`, (req, res) => handleExecutorRpc(req, res, client))
  register(ctx, `${BASE_PATH}/events`, (req, res) => handleExecutorEvents(req, res))
}

export function createTranscriptTarget(client) {
  return Object.freeze({
    status(transcript) {
      return client.request('runtime.tasks.transcript.sync_status', {
        transcriptId: transcript.transcriptId,
        ...(transcript.taskId ? { taskId: transcript.taskId } : {}),
      })
    },
    import(transcript, turns) {
      return client.request('runtime.tasks.transcript.import', {
        transcriptId: transcript.transcriptId,
        ...(transcript.taskId ? { taskId: transcript.taskId } : {}),
        turns,
      })
    },
    acknowledge(turn) {
      return client.request('runtime.tasks.transcript.acknowledge', {
        transcriptId: turn.transcriptId,
        taskId: turn.taskId,
        sequence: turn.cloudSequence,
        ...(turn.parentTranscriptId ? { parentTranscriptId: turn.parentTranscriptId } : {}),
      })
    },
  })
}

export async function readExecutorTurn(client, turn) {
  let beforeCursor
  const pages = []
  const observedCursors = new Set()
  for (;;) {
    const transcript = await client.request('runtime.tasks.transcript', {
      taskId: turn.taskId,
      limit: 100,
      ...(beforeCursor ? { beforeCursor } : {}),
    })
    const turns = Array.isArray(transcript?.turns) ? transcript.turns : []
    pages.push(turns)
    const matched = turn.executorTurnId
      ? turns.find(candidate => candidate?.id === turn.executorTurnId)
      : null
    if (matched) return { ...turn, payload: executorTurnPayload(matched) }
    const nextCursor =
      transcript?.hasMoreBefore && typeof transcript.beforeCursor === 'string'
        ? transcript.beforeCursor
        : null
    if (!nextCursor || observedCursors.has(nextCursor)) break
    observedCursors.add(nextCursor)
    beforeCursor = nextCursor
  }
  if (!turn.executorTurnId) {
    const orderedTurns = pages.reverse().flat()
    const matched = orderedTurns[turn.sequence - 1]
    if (matched) return { ...turn, payload: executorTurnPayload(matched) }
  }
  throw new Error(
    `Executor transcript turn is unavailable: ${turn.taskId}#${turn.executorTurnId ?? turn.sequence}`
  )
}

function executorTurnPayload(turn) {
  const items = Array.isArray(turn.items) ? turn.items : []
  const userMessages = items
    .filter(item => item?.type === 'user_message' && item.message)
    .map(item => ({
      id: item.message.clientUserMessageId ?? item.message.id ?? item.id,
      text: typeof item.message.content === 'string' ? item.message.content : '',
    }))
    .filter(message => message.text)
  const assistantMessage = items
    .filter(
      item =>
        (item?.type === 'assistant_text' && typeof item.content === 'string') ||
        (item?.type === 'agentMessage' && typeof item.text === 'string')
    )
    .map(item => item.content ?? item.text)
    .join('')
  const reasoning = items
    .filter(item => item?.type === 'reasoning')
    .flatMap(item => (Array.isArray(item.summary) ? item.summary : []))
    .filter(value => typeof value === 'string')
    .join('')
  return {
    userMessages,
    assistantMessage,
    reasoning,
    completion: completionFromExecutorTurn(turn),
  }
}

function completionFromExecutorTurn(turn) {
  const status = String(turn.status ?? turn.runtimeStatus ?? 'done').toLowerCase()
  if (status === 'failed' || status === 'error') {
    return { kind: 'error', message: String(turn.error ?? 'Executor turn failed') }
  }
  if (status === 'cancelled' || status === 'canceled' || status === 'interrupted') {
    return { kind: 'interrupted' }
  }
  return { kind: 'completed' }
}

function register(ctx, path, handler) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path, handler }),
    `wework-executor-runtime: ${path}`
  )
}

async function describe(req, res, client) {
  if (!trustedBrowserRequest(req)) return forbidden(res)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return methodNotAllowed(res, 'GET, HEAD')
  }
  try {
    const upstream = await client.describe()
    sendJson(
      res,
      200,
      {
        protocolVersion: 1,
        transport: 'managed',
        executor: upstream,
      },
      req.method === 'HEAD'
    )
  } catch (error) {
    sendError(res, error)
  }
}

export async function handleExecutorRpc(req, res, client) {
  if (!trustedBrowserRequest(req)) return forbidden(res)
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
  const startedAt = Date.now()
  let requestId = requestIdFromRequest(req)
  let method = '<invalid>'
  try {
    const body = await readJsonBody(req)
    if (!isRecord(body) || typeof body.method !== 'string' || !isRecord(body.params)) {
      throw new ExecutorRuntimeError('invalid_params', 'Request must contain method and params')
    }
    requestId = requestId ?? requestIdFromBody(body) ?? randomUUID()
    method = body.method
    console.info('[wework-executor-runtime] RPC request started', {
      request_id: requestId,
      method,
    })
    const result = await client.request(body.method, body.params, undefined, requestId)
    console.info('[wework-executor-runtime] RPC request finished', {
      request_id: requestId,
      method,
      elapsed_ms: Date.now() - startedAt,
      ok: true,
    })
    sendJson(res, 200, { ok: true, result: result ?? null }, false, requestId)
  } catch (error) {
    requestId ??= randomUUID()
    console.error('[wework-executor-runtime] RPC request failed', {
      request_id: requestId,
      method,
      elapsed_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    sendError(res, error, requestId)
  }
}

export async function handleExecutorEvents(
  req,
  res,
  createEventStream = options => LocalEndpointEventByteStream.fromEnvironment(options),
  options = {}
) {
  if (!trustedBrowserRequest(req)) return forbidden(res)
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
  const after = eventCursor(req)
  const replayExisting = shouldReplayExistingEvents(req)
  let active = true
  let eventStream = null
  let source = null
  const disconnect = () => {
    if (!active) return
    active = false
    source?.destroy()
    eventStream?.stop()
  }
  req.once('aborted', disconnect)
  res.once('close', disconnect)
  res.once('error', disconnect)
  try {
    eventStream = createEventStream({
      afterSequence: after,
      replayExisting,
    })
    source = await eventStream.start()
    if (!active || res.writableEnded || res.destroyed) return
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
    })
    await pipeline(
      source,
      new NdjsonSseTransform(),
      new SseResponseSink(res, options.slowConsumerTimeoutMs ?? SLOW_CONSUMER_TIMEOUT_MS)
    )
  } catch (error) {
    disconnect()
    if (!res.headersSent) sendError(res, error)
    else if (!res.writableEnded && !res.destroyed) res.end()
  } finally {
    eventStream?.stop()
    req.off('aborted', disconnect)
    res.off('close', disconnect)
    res.off('error', disconnect)
  }
}

function eventCursor(req) {
  const header = singleHeader(req.headers['last-event-id'])
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('after')
  const value = query ?? header ?? '0'
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function shouldReplayExistingEvents(req) {
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('replay') !== '0'
}

class NdjsonSseTransform extends Transform {
  constructor() {
    super()
    this.buffer = Buffer.alloc(0)
    this.push(Buffer.from(': connected\n\n'))
  }

  _transform(chunk, _encoding, callback) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    if (this.buffer.byteLength > MAX_EVENT_FRAME_BYTES && this.buffer.indexOf(0x0a) < 0) {
      callback(new Error('Executor event frame exceeds size limit'))
      return
    }
    let newline = this.buffer.indexOf(0x0a)
    while (newline >= 0) {
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length > 0) {
        if (line.byteLength > MAX_EVENT_FRAME_BYTES) {
          callback(new Error('Executor event frame exceeds size limit'))
          return
        }
        this.push(Buffer.concat([Buffer.from('data: '), line, Buffer.from('\n\n')]))
      }
      newline = this.buffer.indexOf(0x0a)
    }
    callback()
  }

  _flush(callback) {
    if (this.buffer.length > 0) {
      if (this.buffer.byteLength > MAX_EVENT_FRAME_BYTES) {
        callback(new Error('Executor event frame exceeds size limit'))
        return
      }
      this.push(Buffer.concat([Buffer.from('data: '), this.buffer, Buffer.from('\n\n')]))
    }
    callback()
  }
}

class SseResponseSink extends Writable {
  constructor(response, slowConsumerTimeoutMs) {
    super()
    this.response = response
    this.slowConsumerTimeoutMs = slowConsumerTimeoutMs
    this.drainTimer = null
  }

  _write(chunk, _encoding, callback) {
    if (this.response.writableEnded || this.response.destroyed) {
      callback(new Error('SSE response is closed'))
      return
    }
    if (this.response.write(chunk)) {
      callback()
      return
    }
    const onDrain = () => {
      this.clearDrainTimer()
      callback()
    }
    this.response.once('drain', onDrain)
    this.drainTimer = setTimeout(() => {
      this.response.off('drain', onDrain)
      this.drainTimer = null
      callback(new ExecutorRuntimeError('slow_consumer', 'SSE consumer remained blocked', true))
    }, this.slowConsumerTimeoutMs)
  }

  _final(callback) {
    this.clearDrainTimer()
    if (!this.response.writableEnded && !this.response.destroyed) this.response.end()
    callback()
  }

  _destroy(error, callback) {
    this.clearDrainTimer()
    if (!this.response.writableEnded && !this.response.destroyed) this.response.end()
    callback(error)
  }

  clearDrainTimer() {
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = null
  }
}

async function readJsonBody(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new ExecutorRuntimeError('request_too_large', 'Executor request exceeds size limit')
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ExecutorRuntimeError('invalid_json', 'Request body is not valid JSON')
  }
}

function trustedBrowserRequest(req) {
  const remoteAddress = req.socket?.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) return false
  const fetchSite = singleHeader(req.headers['sec-fetch-site'])
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return false
  const origin = singleHeader(req.headers.origin)
  const host = singleHeader(req.headers.host)
  if (!origin) return true
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendError(res, error, requestId) {
  const body = errorBody(error)
  const status = ['invalid_json', 'invalid_params', 'request_too_large'].includes(body.error.code)
    ? 400
    : body.error.code === 'event_history_lost'
      ? 409
      : body.error.retryable
        ? 503
        : 500
  sendJson(res, status, body, false, requestId)
}

function errorBody(error) {
  const normalized =
    error instanceof ExecutorRuntimeError
      ? error
      : new ExecutorRuntimeError(
          'runtime_failed',
          error instanceof Error ? error.message : String(error),
          true
        )
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      details: normalized.details,
    },
  }
}

function sendJson(res, status, value, head = false, requestId) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(requestId ? { 'x-request-id': requestId } : {}),
  })
  res.end(head ? undefined : body)
}

function forbidden(res) {
  sendJson(res, 403, {
    ok: false,
    error: { code: 'forbidden', message: 'Forbidden', retryable: false },
  })
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'cache-control': 'no-store' })
  res.end()
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value
}

function requestIdFromRequest(req) {
  return normalizedRequestId(singleHeader(req.headers['x-request-id']))
}

function requestIdFromBody(body) {
  return normalizedRequestId(body.id) ?? normalizedRequestId(body.request_id)
}

function normalizedRequestId(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > 128 || /[^\x20-\x7e]/.test(normalized)) return null
  return normalized
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
