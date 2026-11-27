const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]']
const RPC_BODY_TIMEOUT_MS = 15_000

/** Protect every Wework HTTP route with the existing DSH browser session. */
export function createRequestSecurity(connection, port) {
  if (typeof connection?.requestRejection !== 'function') {
    throw new Error('Wework HTTP routes require authenticated DSH Connection')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Wework HTTP authentication requires the listening port')
  }
  const authorities = new Set(
    LOOPBACK_HOSTS.flatMap(host => (port === 80 ? [host, `${host}:80`] : [`${host}:${port}`]))
  )
  const rejection = req =>
    trustedLocalRequest(req, authorities) ? connection.requestRejection(req) : 403
  return Object.freeze({
    wrap(handler, { rpc = false, rpcTimeoutMs = 125_000 } = {}) {
      return (req, res) => {
        const status = rejection(req)
        if (status === undefined) {
          return rpc ? guardRpc(req, res, handler, rpcTimeoutMs) : handler(req, res)
        }
        const code = status === 401 ? 'unauthorized' : 'forbidden'
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
        })
        res.end(JSON.stringify({ ok: false, error: { code, message: code, retryable: false } }))
      }
    },
    wrapUpgrade(handler) {
      return (req, socket, head) => {
        const status = rejection(req)
        if (status === undefined) return handler(req, socket, head)
        socket.end(
          `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`
        )
      }
    },
  })
}

async function guardRpc(req, res, handler, rpcTimeoutMs) {
  const socket = res.socket ?? req.socket
  const route = req.url?.split('?')[0]
  const header = req.headers['x-request-id']
  const requestId =
    typeof header === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(header) ? header : undefined
  const report = (event, extra = {}) =>
    console.info(
      '[wework-http] RPC diagnostic ' + JSON.stringify({ route, requestId, event, ...extra })
    )
  res.once('finish', () => {
    stopDeadline()
    if (res.statusCode < 400) return
    const status = res.statusCode
    report('error_response', { status })
    socket?.once?.('close', hadError => report('connection_closed', { status, hadError }))
  })
  const fail = (status, code) => {
    report('rpc_guard', { code, headersSent: res.headersSent })
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) {
      res.destroy()
      return
    }
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'close',
      })
      res.end(JSON.stringify({ ok: false, error: { code, message: code } }))
    } catch {
      res.destroy()
    }
  }
  const bodyDeadline = setTimeout(() => fail(408, 'body_timeout'), RPC_BODY_TIMEOUT_MS)
  const responseDeadline = setTimeout(() => fail(504, 'rpc_timeout'), rpcTimeoutMs)
  bodyDeadline.unref()
  responseDeadline.unref()
  const stopBodyDeadline = () => clearTimeout(bodyDeadline)
  const stopDeadline = () => {
    stopBodyDeadline()
    clearTimeout(responseDeadline)
    req.off('end', stopBodyDeadline)
    res.off('close', stopDeadline)
  }
  req.once('end', stopBodyDeadline)
  res.once('close', stopDeadline)
  try {
    await handler(req, res)
    // The DSH HTTP middleware can finish writing after res.end() returns.
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      fail(500, 'response_not_finished')
    }
  } catch {
    fail(500, 'rpc_handler_failed')
  }
}

function trustedLocalRequest(req, authorities) {
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress)) return false
  const { host, origin, 'sec-fetch-site': fetchSite } = req.headers
  if (typeof host !== 'string' || !authorities.has(host)) return false
  // Node keeps only the first Host header; reject ambiguous wire requests as well.
  if (
    req.rawHeaders?.filter(
      (_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host'
    ).length > 1
  )
    return false
  if (fetchSite !== undefined && !['same-origin', 'none'].includes(fetchSite)) return false
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  return origin === new URL(`http://${host}`).origin
}
