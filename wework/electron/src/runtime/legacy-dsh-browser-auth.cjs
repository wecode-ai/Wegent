// Install before the legacy runtime loads so no unauthenticated request can
// reach a route, including routes registered before the profile's plugins.
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto')
const { writeSync } = require('node:fs')
const { Server } = require('node:http')

if (process.env.WEWORK_DSH_BROWSER_AUTH_FD !== '5') {
  throw new Error('Legacy DSH requires a private browser authentication pipe')
}

const bootstrapToken = randomBytes(32).toString('base64url')
const sessionToken = randomBytes(32).toString('base64url')
let bootstrapAvailable = true
let primaryServer
const originalEmit = Server.prototype.emit

function matches(value, expected) {
  if (typeof value !== 'string') return false
  const actual = Buffer.from(value)
  const required = Buffer.from(expected)
  return actual.length === required.length && timingSafeEqual(actual, required)
}

function authority(server) {
  const address = server.address()
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') return null
  return `127.0.0.1:${address.port}`
}

function authorized(request, host, cookieName) {
  if (request.headers.host !== host) return false
  if (request.headers.origin && request.headers.origin !== `http://${host}`) return false
  if (
    request.headers['sec-fetch-site'] &&
    !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])
  )
    return false
  const cookies = (request.headers.cookie || '').split(';').map(cookie => cookie.trim())
  return cookies.some(cookie => {
    const separator = cookie.indexOf('=')
    return (
      cookie.slice(0, separator) === cookieName &&
      matches(cookie.slice(separator + 1), sessionToken)
    )
  })
}

Server.prototype.emit = function (event, ...args) {
  if (event === 'listening') {
    const host = authority(this)
    if (!host) throw new Error('Legacy DSH browser authentication requires IPv4 loopback')
    if (!primaryServer) {
      primaryServer = this
      writeSync(5, JSON.stringify({ url: `http://${host}/?token=${bootstrapToken}` }) + '\n')
    }
  }
  if (event === 'request' || event === 'upgrade') {
    const [request, target] = args
    const host = authority(this)
    const cookieName = host && `dsh-auth-${createHash('sha256').update(host).digest('base64url')}`
    if (this === primaryServer && host && request.headers.host === host) {
      let url
      try {
        url = new URL(request.url, `http://${host}`)
      } catch {
        url = null
      }
      if (
        event === 'request' &&
        request.method === 'GET' &&
        url?.pathname === '/' &&
        url.origin === `http://${host}` &&
        bootstrapAvailable &&
        matches(url.searchParams.get('token'), bootstrapToken) &&
        (!request.headers.origin || request.headers.origin === url.origin) &&
        (!request.headers['sec-fetch-site'] ||
          ['same-origin', 'none'].includes(request.headers['sec-fetch-site']))
      ) {
        bootstrapAvailable = false
        target.writeHead(204, {
          'Set-Cookie': `${cookieName}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        })
        target.end()
        return true
      }
      if (url?.origin === `http://${host}` && authorized(request, host, cookieName)) {
        if (event === 'request') target.setHeader('Cache-Control', 'no-store')
        return originalEmit.call(this, event, ...args)
      }
    }
    if (event === 'upgrade') {
      // Node removes its HTTP socket error handler before emitting upgrades.
      target.once('error', () => target.destroy())
      target.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    } else {
      target.writeHead(401, { 'Cache-Control': 'no-store' })
      target.end('Unauthorized')
    }
    return true
  }
  return originalEmit.call(this, event, ...args)
}
