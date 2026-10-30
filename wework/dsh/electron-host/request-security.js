const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

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
    wrap(handler) {
      return (req, res) => {
        const status = rejection(req)
        if (status === undefined) return handler(req, res)
        const code = status === 401 ? 'unauthorized' : 'forbidden'
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
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
