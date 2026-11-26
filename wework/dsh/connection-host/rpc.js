import { timingSafeEqual } from 'node:crypto'
const PERMANENT_ERRORS = new Set([
  'connector_auth_required',
  'connection_response_invalid',
  'invalid_connection',
  'forbidden',
  'connection_tool_denied',
  'connection_cli_request_failed',
  'connection_cli_response_invalid',
])
const BODY_TIMEOUT_MS = 15_000
const RESPONSE_TIMEOUT_MS = 125_000
export async function handleConnectionRpc(req, res, token, request) {
  const authorization = req.headers.authorization
  const expected = Buffer.from(`Bearer ${token}`)
  const actual = Buffer.from(typeof authorization === 'string' ? authorization : '')
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
  let status = 200
  let response
  let collection = false
  let responseTimer
  const controller = new AbortController()
  const stopDeadlines = () => {
    clearTimeout(bodyTimer)
    clearTimeout(responseTimer)
  }
  const disconnect = () => {
    stopDeadlines()
    controller.abort()
  }
  const send = (status, value) => {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) return res.destroy()
    if (status >= 400) {
      const code = value.error.code
      const socket = res.socket
      console.info('[wework-connection-host] RPC error', { status, code })
      socket?.once('close', hadError =>
        console.info('[wework-connection-host] RPC connection closed', { status, code, hadError })
      )
    }
    try {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(status >= 400 ? { connection: 'close' } : {}),
      })
      res.end(JSON.stringify(value))
    } catch {
      res.destroy()
    }
  }
  const deadline = (status, code) => {
    send(status, { ok: false, error: { code, message: code } })
    controller.abort()
  }
  const bodyTimer = setTimeout(() => deadline(408, 'body_timeout'), BODY_TIMEOUT_MS)
  bodyTimer.unref()
  res.once?.('close', disconnect)
  try {
    if (!loopback || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      status = 403
      throw connectionError('forbidden', 'Forbidden')
    }
    if (req.method !== 'POST') {
      status = 405
      throw connectionError('invalid_method', 'POST is required')
    }
    let size = 0
    const chunks = []
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += Buffer.byteLength(chunk)
      if (size > 1024 * 1024)
        throw connectionError('request_too_large', 'Connection request is too large')
      chunks.push(Buffer.from(chunk))
    }
    clearTimeout(bodyTimer)
    if (controller.signal.aborted || res.writableEnded || res.destroyed) return
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const responseTimeout =
      body.method === 'installWebConnection'
        ? 15 * 60_000 + 30_000
        : body.method === 'trialWebConnection'
          ? 290_000
          : RESPONSE_TIMEOUT_MS
    responseTimer = setTimeout(() => deadline(504, 'connection_timeout'), responseTimeout)
    responseTimer.unref()
    collection = body.method === 'collectObservation'
    response = {
      ok: true,
      result: await request(
        body,
        collection || body.method === 'trialWebConnection' ? controller.signal : undefined
      ),
    }
  } catch (error) {
    if (status === 200) status = error.code === 'request_too_large' ? 413 : 400
    response = {
      ok: false,
      error: {
        code: error.code ?? 'connection_failed',
        message: error.message,
        ...(typeof error.providerCode === 'string' &&
        /^[A-Za-z0-9_.:-]{1,64}$/.test(error.providerCode)
          ? { providerCode: error.providerCode }
          : {}),
        ...(collection &&
        !PERMANENT_ERRORS.has(error.code) &&
        Number.isSafeInteger(error.retryAfterMs) &&
        error.retryAfterMs >= 1 &&
        error.retryAfterMs <= 3600000
          ? { retryAfterMs: error.retryAfterMs }
          : {}),
      },
    }
  } finally {
    stopDeadlines()
    res.removeListener?.('close', disconnect)
  }
  send(status, response)
}

function connectionError(code, message) {
  return Object.assign(new Error(message), { code })
}
