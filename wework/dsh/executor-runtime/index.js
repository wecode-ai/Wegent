import { ExecutorRuntimeClient, ExecutorRuntimeError } from './executor-runtime-client.js'

export const name = 'wework-executor-runtime'
export const inject = ['webServer']

const BASE_PATH = '/wework/executor/v1'
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

export async function apply(ctx) {
  const client = ExecutorRuntimeClient.fromEnvironment()
  await client.start()
  ctx.effect(() => () => client.stop(), 'wework-executor-runtime: transport')
  register(ctx, BASE_PATH, (req, res) => describe(req, res, client))
  register(ctx, `${BASE_PATH}/rpc`, (req, res) => rpc(req, res, client))
  register(ctx, `${BASE_PATH}/events`, (req, res) => handleExecutorEvents(req, res, client))
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

async function rpc(req, res, client) {
  if (!trustedBrowserRequest(req)) return forbidden(res)
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
  try {
    const body = await readJsonBody(req)
    if (!isRecord(body) || typeof body.method !== 'string' || !isRecord(body.params)) {
      throw new ExecutorRuntimeError('invalid_params', 'Request must contain method and params')
    }
    const result = await client.request(body.method, body.params)
    sendJson(res, 200, { ok: true, result: result ?? null })
  } catch (error) {
    sendError(res, error)
  }
}

export async function handleExecutorEvents(req, res, client) {
  if (!trustedBrowserRequest(req)) return forbidden(res)
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
  const after = eventCursor(req)
  try {
    const replay = client.replay(after)
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
    })
    let dispose = () => {}
    const write = event => {
      const writable = res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
      if (!writable) {
        dispose()
        res.end()
      }
    }
    for (const event of replay) write(event)
    if (res.writableEnded) return
    dispose = client.listen(write)
    req.on('close', dispose)
    res.write(': connected\n\n')
  } catch (error) {
    if (!res.headersSent) sendError(res, error)
    else res.end(`event: error\ndata: ${JSON.stringify(errorBody(error))}\n\n`)
  }
}

function eventCursor(req) {
  const header = singleHeader(req.headers['last-event-id'])
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('after')
  const value = header ?? query ?? '0'
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
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

function sendError(res, error) {
  const body = errorBody(error)
  const status = ['invalid_json', 'invalid_params', 'request_too_large'].includes(body.error.code)
    ? 400
    : body.error.code === 'event_history_lost'
      ? 409
      : body.error.retryable
        ? 503
        : 500
  sendJson(res, status, body)
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

function sendJson(res, status, value, head = false) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
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

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
