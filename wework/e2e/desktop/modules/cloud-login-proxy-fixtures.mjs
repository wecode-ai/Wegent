import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'

// Desktop sign-in has to travel through the operating system's proxy configuration, exactly like the
// renderer and the authorization window. This fixture publishes the cloud backend on a host name that
// only resolves through the local proxy, so a request that ignores the proxy fails to resolve while a
// request that uses it succeeds. That mirrors the customer report: the authorization page opened, and
// then the main-process poll reported that the cloud was unreachable.
export const CLOUD_LOGIN_PROXY_BACKEND_HOST = 'wegent-cloud-login.invalid'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()))
}

async function startRoutingProxy({ backendHost, backendPort, requests, observe }) {
  const server = createServer((req, res) => {
    let target
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    requests.push(`${req.method ?? 'GET'} ${target.origin}${target.pathname}`)
    if (target.hostname !== backendHost || target.port !== backendPort) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`The cloud login proxy has no upstream for ${target.host}`)
      return
    }
    observe(req.method ?? 'GET', target.pathname)
    const upstream = request({
      headers: { ...req.headers, host: target.host },
      hostname: '127.0.0.1',
      method: req.method,
      path: `${target.pathname}${target.search}`,
      port: Number(target.port || 80),
    })
    upstream.on('response', upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    })
    upstream.on('error', error => {
      if (res.headersSent) {
        res.destroy(error)
        return
      }
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(error.message)
    })
    req.pipe(upstream)
  })
  server.on('connect', (req, socket) => {
    requests.push(`CONNECT ${req.url}`)
    // Chromium sends its own background CONNECT requests through this proxy and drops the tunnels it
    // no longer needs, so every socket needs an error listener before it can be written to.
    socket.on('error', () => socket.destroy())
    const [host, port] = String(req.url ?? '').split(':')
    if (host !== backendHost || port !== backendPort) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const upstream = connect(Number(port || 443), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
  })
  server.on('upgrade', (_req, socket) => {
    socket.on('error', () => undefined)
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  const port = await listen(server)
  return { port, server }
}

export async function startCloudLoginProxyFixture({
  backendUrl,
  authToken,
  backendHost = CLOUD_LOGIN_PROXY_BACKEND_HOST,
}) {
  const target = new URL(backendUrl)
  assert.equal(target.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname))
  const backendRequests = []
  const proxyRequests = []
  const pending = new Set()
  const approvedSessions = new Set()
  let polls = 0
  let failure
  const proxy = await startRoutingProxy({
    backendHost,
    backendPort: target.port,
    requests: proxyRequests,
    observe(method, path) {
      backendRequests.push(method + ' ' + path)
      const match = path.match(/^\/api\/auth\/wework\/sessions\/([^/]+)\/poll$/)
      if (!match || ++polls === 1 || approvedSessions.has(match[1])) return
      approvedSessions.add(match[1])
      const operation = fetch(backendUrl + '/api/auth/wework/sessions/' + match[1] + '/approve', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + authToken },
      })
        .then(response => {
          assert.ok(response.ok, 'The real fixture user must approve its native session')
        })
        .catch(error => {
          failure ??= error
        })
        .finally(() => pending.delete(operation))
      pending.add(operation)
    },
  })
  return {
    backendHost,
    backendUrl: 'http://' + backendHost + ':' + target.port,
    proxyUrl: 'http://127.0.0.1:' + proxy.port,
    backendRequests,
    proxyRequests,
    pollCount: () => polls,
    pollProxyRequests: () => proxyRequests.filter(line => line.includes('/poll')),
    async stop() {
      await Promise.all(pending)
      await close(proxy.server)
      if (failure) throw failure
    },
  }
}
