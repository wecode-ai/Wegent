import { createRequestSecurity } from './request-security.js'
import { ElectronHostClient, ElectronHostError } from './electron-host-client.js'
import { createWeworkDesktopService, WEWORK_DESKTOP_SERVICE_KEY } from './desktop-service.js'

export const name = 'wework-electron-host'
export const inject = ['webServer', 'connection']

const BASE_PATH = '/wework/electron-host/v1'
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024

export async function apply(ctx) {
  const security = createRequestSecurity(ctx.connection, ctx.webServer.port)
  ctx.effect(
    () => ctx.reflect.provide('weworkRequestSecurity', security),
    'wework-electron-host: local HTTP authentication'
  )
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
        handler: security.wrap((req, res) => describe(req, res, client)),
      }),
    `wework-electron-host: ${BASE_PATH}`
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE_PATH}/invoke`,
        handler: security.wrap((req, res) => invoke(req, res, client)),
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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD')
    return
  }
  sendJson(res, 200, client.describe(), req.method === 'HEAD')
}

async function invoke(req, res, client) {
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

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
