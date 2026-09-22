import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'

// Desktop sign-in has to travel through the operating system's proxy configuration, exactly like the
// renderer and the authorization window. This fixture publishes the cloud backend on a host name that
// only resolves through the local proxy, so a request that ignores the proxy fails to resolve while a
// request that uses it succeeds. That mirrors the customer report: the authorization page opened, and
// then the main-process poll reported that the cloud was unreachable.
export const CLOUD_LOGIN_PROXY_BACKEND_HOST = 'wegent-cloud-login.invalid'

const DEFAULT_PENDING_POLLS = 1
const CLOUD_LOGIN_USER = { email: 'cloud-login@e2e.local', id: 1, user_name: 'e2e-cloud-login' }
const ACCESS_TOKEN = 'e2e-cloud-access-token'
const REFRESH_TOKEN = 'e2e-cloud-refresh-token'
const CORS_HEADERS = {
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
  'access-control-allow-origin': '*',
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()))
}

function readRequestBody(req) {
  return new Promise(resolve => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
  })
  res.end(body)
}

async function startMockCloudBackend({ backendHost, pendingPolls, requests }) {
  // The advertised origin is fixed once the port is known, which happens after the first request can
  // already be served.
  const origin = { value: '' }
  const polls = { count: 0 }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      requests.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS)
        res.end()
        return
      }
      if (url.pathname === '/api/health') {
        sendJson(res, 200, { shutting_down: false, status: 'healthy' })
        return
      }
      if (url.pathname === '/api/auth/wework/config') {
        // Keep the socket on loopback: this checkpoint covers the HTTP sign-in path, and a socket
        // endpoint behind the proxy would only add reconnect noise here.
        sendJson(res, 200, { socket_url: loopbackSocketUrl(server), web_url: origin.value })
        return
      }
      if (url.pathname === '/api/auth/wework/sessions' && req.method === 'POST') {
        const body = JSON.parse((await readRequestBody(req)) || '{}')
        assert.ok(
          body.device_public_key,
          'The desktop client did not publish its device public key'
        )
        const sessionId = randomUUID()
        sendJson(res, 200, {
          // A non-HTTP authorization URL keeps automation from opening a system browser; the renderer
          // skips the external window and continues to the polling step this checkpoint covers.
          authorize_url: `wework-e2e://cloud-authorization/${sessionId}`,
          expires_at: Math.floor(Date.now() / 1000) + 600,
          poll_interval_seconds: 1,
          poll_token: randomBytes(16).toString('base64url'),
          session_id: sessionId,
          web_url: origin.value,
        })
        return
      }
      if (/^\/api\/auth\/wework\/sessions\/[^/]+\/poll$/.test(url.pathname)) {
        polls.count += 1
        if (polls.count <= pendingPolls) {
          sendJson(res, 200, { error: null, status: 'pending' })
          return
        }
        sendJson(res, 200, {
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          status: 'success',
          token_type: 'bearer',
          username: CLOUD_LOGIN_USER.user_name,
        })
        return
      }
      if (url.pathname === '/api/users/me') {
        sendJson(res, 200, CLOUD_LOGIN_USER)
        return
      }
      sendJson(res, 404, { detail: 'Not Found' })
    } catch (error) {
      // The app abandons requests while it restarts; the checkpoint reports protocol failures through
      // the recorded requests instead of failing the harness.
      if (!res.headersSent) sendJson(res, 500, { detail: String(error?.message ?? error) })
      else res.destroy()
    }
  })
  const port = await listen(server)
  origin.value = `http://${backendHost}:${port}`
  return { polls, server }
}

function loopbackSocketUrl(server) {
  return `http://127.0.0.1:${server.address().port}`
}

async function startRoutingProxy({ backendHost, requests }) {
  const server = createServer((req, res) => {
    let target
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    requests.push(`${req.method ?? 'GET'} ${req.url}`)
    if (target.hostname !== backendHost) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`The cloud login proxy has no upstream for ${target.host}`)
      return
    }
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
    if (host !== backendHost) {
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

export async function startCloudLoginProxyFixture(options = {}) {
  const backendHost = options.backendHost ?? CLOUD_LOGIN_PROXY_BACKEND_HOST
  const pendingPolls = options.pendingPolls ?? DEFAULT_PENDING_POLLS
  const backendRequests = []
  const proxyRequests = []
  let backend
  let proxy
  try {
    backend = await startMockCloudBackend({ backendHost, pendingPolls, requests: backendRequests })
    proxy = await startRoutingProxy({ backendHost, requests: proxyRequests })
  } catch (error) {
    if (backend) await close(backend.server)
    if (proxy) await close(proxy.server)
    throw error
  }

  return {
    backendHost,
    backendUrl: `http://${backendHost}:${backend.server.address().port}`,
    proxyUrl: `http://127.0.0.1:${proxy.port}`,
    backendRequests,
    proxyRequests,
    pollCount: () => backend.polls.count,
    pollProxyRequests: () => proxyRequests.filter(line => line.includes('/poll')),
    async stop() {
      await Promise.all([close(backend.server), close(proxy.server)])
    },
  }
}
