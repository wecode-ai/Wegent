import { ElectronHostClient, ElectronHostError } from './electron-host-client.js'
import { createWeworkDesktopService, WEWORK_DESKTOP_SERVICE_KEY } from './desktop-service.js'

export const name = 'wework-electron-host'
export const inject = ['webServer']

const BASE_PATH = '/wework/electron-host/v1'
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024

export async function apply(ctx) {
  const client = ElectronHostClient.fromEnvironment(process.env, {
    onDisconnect: hostDisconnectHandler(ctx),
  })
  await client.start()
  const generation = createWeworkDesktopService(client)
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide(WEWORK_DESKTOP_SERVICE_KEY, generation.service)
    return () => {
      unprovide()
      generation.dispose()
      client.stop()
    }
  }, 'wework-electron-host: desktop service generation')
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: BASE_PATH,
        handler: (req, res) => describe(req, res, client),
      }),
    `wework-electron-host: ${BASE_PATH}`
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE_PATH}/invoke`,
        handler: (req, res) => invoke(req, res, client),
      }),
    `wework-electron-host: ${BASE_PATH}/invoke`
  )
}

export function hostDisconnectHandler(ctx) {
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') {
    throw new Error('wework-electron-host requires the DSH launcher appExit service')
  }
  return () => exit(0)
}

async function describe(req, res, client) {
  if (!trustedBrowserRequest(req)) {
    sendJson(res, 403, { error: { code: 'forbidden', message: 'Forbidden' } })
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD')
    return
  }
  sendJson(res, 200, client.describe(), req.method === 'HEAD')
}

async function invoke(req, res, client) {
  if (!trustedBrowserRequest(req)) {
    sendJson(res, 403, { error: { code: 'forbidden', message: 'Forbidden' } })
    return
  }
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  try {
    const body = await readJsonBody(req)
    if (!isRecord(body) || typeof body.capability !== 'string' || !isRecord(body.params)) {
      throw new ElectronHostError('invalid_params', 'Request must contain capability and params')
    }
    const result = await client.invoke(body.capability, body.params)
    sendJson(res, 200, { ok: true, result: result ?? null })
  } catch (error) {
    const normalized =
      error instanceof ElectronHostError
        ? error
        : new ElectronHostError(
            'capability_failed',
            error instanceof Error ? error.message : String(error)
          )
    sendJson(res, statusForError(normalized), {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      },
    })
  }
}

function trustedBrowserRequest(req) {
  const remoteAddress = req.socket?.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
    return false
  }
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

async function readJsonBody(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new ElectronHostError('request_too_large', 'Electron host request exceeds size limit')
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ElectronHostError('invalid_json', 'Request body is not valid JSON')
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

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'cache-control': 'no-store' })
  res.end()
}

function statusForError(error) {
  if (['invalid_json', 'invalid_params', 'request_too_large'].includes(error.code)) {
    return 400
  }
  if (error.code === 'capability_denied') return 403
  if (error.code === 'host_timeout') return 504
  if (['client_closed', 'client_not_ready', 'host_disconnected'].includes(error.code)) {
    return 503
  }
  return 500
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
