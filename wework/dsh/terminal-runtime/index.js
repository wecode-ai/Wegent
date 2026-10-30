import { spawn } from 'node-pty'
import { streamTerminalEvents } from './sse-events.js'
import { TerminalRuntime, TerminalRuntimeError } from './terminal-runtime.js'

export const name = 'wework-terminal-runtime'
export const inject = ['webServer', 'weworkRequestSecurity']

const BASE_PATH = '/wework/terminal/v1'
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

export function apply(ctx) {
  const runtime = new TerminalRuntime({ spawn })
  ctx.effect(() => () => runtime.dispose(), 'wework-terminal-runtime: PTY registry')
  register(ctx, BASE_PATH, (req, res) => describe(req, res, runtime))
  register(ctx, `${BASE_PATH}/rpc`, (req, res) => rpc(req, res, runtime))
  register(ctx, `${BASE_PATH}/events`, (req, res) => events(req, res, runtime))
}

function register(ctx, path, handler) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: ctx.weworkRequestSecurity.wrap(handler),
      }),
    `wework-terminal-runtime: ${path}`
  )
}

function describe(req, res, runtime) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return methodNotAllowed(res, 'GET, HEAD')
  }
  sendJson(res, 200, runtime.describe(), req.method === 'HEAD')
}

async function rpc(req, res, runtime) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
  try {
    const body = await readJsonBody(req)
    if (!isRecord(body) || typeof body.method !== 'string' || !isRecord(body.params)) {
      throw new TerminalRuntimeError(
        'invalid_params',
        'Request must contain method and params',
        400
      )
    }
    const result = await runtime.request(body.method, body.params)
    sendJson(res, 200, { ok: true, result: result ?? null })
  } catch (error) {
    sendError(res, error)
  }
}

function events(req, res, runtime) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
  streamTerminalEvents(req, res, runtime, eventCursor(req))
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
      throw new TerminalRuntimeError(
        'request_too_large',
        'Terminal request exceeds size limit',
        413
      )
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new TerminalRuntimeError('invalid_json', 'Request body is not valid JSON', 400)
  }
}

function sendError(res, error) {
  const normalized =
    error instanceof TerminalRuntimeError
      ? error
      : new TerminalRuntimeError(
          'terminal_failed',
          error instanceof Error ? error.message : String(error)
        )
  sendJson(res, normalized.status, {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.status >= 500,
    },
  })
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
