import assert from 'node:assert/strict'
import { request } from 'node:http'
import { fetchLocalRuntime } from './runtime-request.mjs'

function unauthenticatedRequest(origin, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, origin), { method: 'POST', headers }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    req.setTimeout(10_000, () => req.destroy(new Error('Runtime security request timed out')))
    req.on('error', reject)
    req.end('{}')
  })
}

export async function verifyRuntimeRequestSecurity(control, origin) {
  const port = new URL(origin).port
  const paths = [
    '/wework/terminal/v1/rpc',
    '/wework/executor/v1/rpc',
    '/wework/electron-host/v1/invoke',
    '/wework/plugins/v1/rpc',
  ]
  for (const path of paths) {
    assert.equal(
      await unauthenticatedRequest(origin, path, {
        host: `rebind.attacker.test:${port}`,
        origin: `http://rebind.attacker.test:${port}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      }),
      403,
      `${path} accepted a DNS rebinding request`
    )
    assert.equal(
      await unauthenticatedRequest(origin, path),
      401,
      `${path} accepted a request without browser authentication`
    )
  }
  for (const path of [
    '/wework/terminal/v1',
    '/wework/executor/v1',
    '/wework/electron-host/v1',
    '/wework/app/runtime-config.js',
  ]) {
    const denied = await fetch(new URL(path, origin))
    await denied.text()
    assert.equal(denied.status, 401, `${path} disclosed unauthenticated data`)
    const allowed = await fetchLocalRuntime(control, new URL(path, origin))
    await allowed.text()
    assert.equal(allowed.status, 200, `${path} rejected the authenticated Electron session`)
  }
  for (const path of ['/wework/terminal/v1/events', '/wework/executor/v1/events']) {
    const response = await fetch(new URL(path, origin))
    await response.text()
    assert.equal(response.status, 401, `${path} exposed an unauthenticated event stream`)
  }
}
