export const name = 'wework-plugin-runtime'
export const inject = ['webServer']
export const BASE_PATH = '/wework/plugins/v1/rpc'

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

export function apply(ctx) {
  const registrations = new Map()
  let active = true

  const service = Object.freeze({
    register(owner, registration) {
      if (!active) throw new Error('Wework plugin runtime is disposed')
      if (!owner || typeof owner.effect !== 'function') {
        throw new Error('Plugin backend registration requires a Cordis context owner')
      }
      const id = requiredId(registration?.id, 'Plugin backend id')
      if (!registration?.methods || typeof registration.methods !== 'object') {
        throw new Error('Plugin backend methods must be an object')
      }
      if (registrations.has(id)) throw new Error(`Plugin backend already registered: ${id}`)
      const methods = new Map()
      for (const [rawMethod, handler] of Object.entries(registration.methods)) {
        const method = requiredId(rawMethod, 'Plugin backend method')
        if (typeof handler !== 'function') {
          throw new Error(`Plugin backend handler must be a function: ${id}/${method}`)
        }
        methods.set(method, handler)
      }
      if (methods.size === 0) throw new Error('Plugin backend must declare at least one method')
      const entry = Object.freeze({ id, methods })
      registrations.set(id, entry)
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        if (registrations.get(id) === entry) registrations.delete(id)
      }
      owner.effect(() => dispose, `wework-plugin-runtime: ${id}`)
      return dispose
    },
  })

  const request = async (pluginId, methodName, params) => {
    if (!active) throw new PluginRuntimeError('runtime_disposed', 'Plugin runtime is disposed', 503)
    const plugin = registrations.get(requiredId(pluginId, 'Plugin backend id'))
    if (!plugin) {
      throw new PluginRuntimeError(
        'plugin_not_found',
        `Plugin backend is not registered: ${pluginId}`,
        404
      )
    }
    const method = requiredId(methodName, 'Plugin backend method')
    const handler = plugin.methods.get(method)
    if (!handler) {
      throw new PluginRuntimeError(
        'method_not_found',
        `Plugin backend method is not registered: ${pluginId}/${method}`,
        404
      )
    }
    if (!isRecord(params)) {
      throw new PluginRuntimeError('invalid_params', 'Plugin backend params must be an object', 400)
    }
    return handler(Object.freeze({ ...params }))
  }

  ctx.effect(() => {
    const unprovide = ctx.reflect.provide('weworkPluginRuntime', service)
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: BASE_PATH,
      handler: (req, res) => handleRpc(req, res, request),
    })
    return () => {
      active = false
      registrations.clear()
      unregister()
      unprovide()
    }
  }, 'wework-plugin-runtime: service')
}

export async function handleRpc(req, res, request) {
  if (!trustedBrowserRequest(req))
    return sendError(res, new PluginRuntimeError('forbidden', 'Forbidden', 403))
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
    res.end()
    return
  }
  try {
    const body = await readJsonBody(req)
    if (!isRecord(body)) {
      throw new PluginRuntimeError('invalid_request', 'Request body must be an object', 400)
    }
    const result = await request(body.plugin, body.method, body.params ?? {})
    sendJson(res, 200, { ok: true, result: result ?? null })
  } catch (error) {
    sendError(res, error)
  }
}

export class PluginRuntimeError extends Error {
  constructor(code, message, status = 500) {
    super(message)
    this.name = 'PluginRuntimeError'
    this.code = code
    this.status = status
  }
}

async function readJsonBody(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new PluginRuntimeError('request_too_large', 'Plugin request exceeds size limit', 413)
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new PluginRuntimeError('invalid_json', 'Request body is not valid JSON', 400)
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
  const normalized =
    error instanceof PluginRuntimeError
      ? error
      : new PluginRuntimeError(
          'backend_failed',
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

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new PluginRuntimeError('invalid_id', `${label} must match ${ID_PATTERN}`, 400)
  }
  return value
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
