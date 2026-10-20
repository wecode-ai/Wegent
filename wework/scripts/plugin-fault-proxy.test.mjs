import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import test from 'node:test'
import { PluginFaultProxy } from '../e2e/desktop/modules/plugin-fault-proxy.mjs'
import { until } from '../e2e/desktop/modules/plugin-regression-fixture.mjs'

async function fixture(t) {
  const received = []
  const server = createServer((request, response) => {
    received.push({ method: request.method, url: request.url })
    request.resume()
    response.writeHead(request.method === 'DELETE' ? 204 : 200)
    response.end(request.method === 'DELETE' ? undefined : 'real-upstream-body')
  })
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const proxy = await new PluginFaultProxy(`http://127.0.0.1:${server.address().port}`).start()
  t.after(async () => {
    await proxy.stop()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  return { proxy, received, server }
}

test(
  'forwards the real upstream status/body and never records credentials',
  { timeout: 5000 },
  async t => {
    const { proxy, received } = await fixture(t)
    const response = await fetch(`${proxy.url}/api/plugins/installed?device_id=private`, {
      headers: { Authorization: 'Bearer secret', 'X-Request-ID': 'private-logical-id' },
    })
    assert.equal(await response.text(), 'real-upstream-body')
    assert.equal(received.length, 1)
    assert.equal(proxy.requests[0].unscoped, false)
    assert.ok(!JSON.stringify(proxy.requests).includes('secret'))
    assert.ok(!JSON.stringify(proxy.requests).includes('private'))
    assert.match(proxy.requests[0].requestIdFingerprint, /^[a-f0-9]{64}$/)
    await fetch(`${proxy.url}/api/plugins/installed`, {
      headers: { 'X-Request-ID': 'private-logical-id' },
    })
    await fetch(`${proxy.url}/api/plugins/installed`, {
      headers: { 'X-Request-ID': 'another-private-logical-id' },
    })
    assert.equal(proxy.requests[0].requestIdFingerprint, proxy.requests[1].requestIdFingerprint)
    assert.notEqual(proxy.requests[0].requestIdFingerprint, proxy.requests[2].requestIdFingerprint)
    assert.ok(!JSON.stringify(proxy.requests).includes('private'))
  }
)

test(
  'held request is not forwarded, including after abort and fault release',
  { timeout: 5000 },
  async t => {
    const { proxy, received } = await fixture(t)
    proxy.rule = () => 'hold-request'
    const controller = new AbortController()
    const rejected = assert.rejects(
      fetch(`${proxy.url}/api/plugins/installed/1`, { method: 'DELETE', signal: controller.signal })
    )
    await until(
      () => proxy.requests.length,
      count => count === 1,
      'Proxy did not receive DELETE',
      2000
    )
    controller.abort()
    await rejected
    proxy.rule = () => null
    await fetch(`${proxy.url}/api/plugins/installed`)
    assert.deepEqual(received, [{ method: 'GET', url: '/api/plugins/installed' }])
  }
)

test(
  'held DELETE response commits upstream exactly once and leaves verification GET available',
  { timeout: 5000 },
  async t => {
    const { proxy, received } = await fixture(t)
    proxy.rule = request => (request.method === 'DELETE' ? 'hold-response' : null)
    const controller = new AbortController()
    const rejected = assert.rejects(
      fetch(`${proxy.url}/api/plugins/installed/1`, { method: 'DELETE', signal: controller.signal })
    )
    await until(
      () => proxy.requests[0]?.committedResponseHeld,
      Boolean,
      'Upstream response was not held',
      2000
    )
    controller.abort()
    await rejected
    assert.equal(proxy.requests[0].status, 204)
    assert.equal(proxy.requests[0].committedResponseHeld, true)
    assert.equal(
      await (await fetch(`${proxy.url}/api/plugins/installed`)).text(),
      'real-upstream-body'
    )
    assert.equal(received.filter(request => request.method === 'DELETE').length, 1)
  }
)

test(
  'lost mutation response fails after the real upstream commit without replaying the request',
  { timeout: 5000 },
  async t => {
    const { proxy, received } = await fixture(t)
    proxy.rule = request => (request.method === 'POST' ? 'drop-response' : null)
    await assert.rejects(
      fetch(`${proxy.url}/api/plugins/marketplace/1/install`, {
        method: 'POST',
        body: 'real-install-request',
        signal: AbortSignal.timeout(2000),
      }),
      /fetch failed/
    )
    assert.equal(proxy.requests[0].status, 200)
    assert.equal(proxy.requests[0].committedResponseDropped, true)
    assert.equal(received.filter(request => request.method === 'POST').length, 1)
    assert.equal(
      await (await fetch(`${proxy.url}/api/plugins/installed`)).text(),
      'real-upstream-body'
    )
    proxy.rule = () => null
    await fetch(`${proxy.url}/api/plugins/marketplace/1/install`, { method: 'POST' })
    assert.equal(received.filter(request => request.method === 'POST').length, 2)
  }
)

test(
  'delays a completed real reply, allows a newer read, then releases the original bytes',
  { timeout: 5000 },
  async t => {
    const { proxy, received, server } = await fixture(t)
    server.removeAllListeners('request')
    let version = 'older-real-body'
    server.on('request', (request, response) => {
      received.push({ method: request.method, url: request.url })
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.end(version)
    })
    proxy.rule = () => 'delay-response'
    let settled = false
    const older = fetch(`${proxy.url}/api/plugins/installed`).then(async response => {
      settled = true
      return { contentType: response.headers.get('content-type'), body: await response.text() }
    })
    await until(
      () => proxy.requests[0]?.delayedResponseReady,
      Boolean,
      'Real response was not retained before release',
      2000
    )
    assert.equal(settled, false)
    assert.equal(proxy.requests[0].status, 200)
    assert.notEqual(proxy.requests[0].responseCompleted, true)
    version = 'newer-real-body'
    proxy.rule = () => null
    assert.equal(await (await fetch(`${proxy.url}/api/plugins/installed`)).text(), version)
    assert.equal(
      proxy.releaseDelayedResponses(entry => entry === proxy.requests[0]),
      1
    )
    assert.deepEqual(await older, {
      contentType: 'application/octet-stream',
      body: 'older-real-body',
    })
    assert.equal(proxy.requests[0].delayedResponseReleased, true)
    assert.equal(proxy.requests[0].responseCompleted, true)
    assert.equal(received.length, 2, 'Releasing a reply must not replay an upstream request')
    assert.equal(proxy.releaseDelayedResponses(), 0)
    assert.ok(!JSON.stringify(proxy.requests).includes('real-body'))
  }
)

test(
  'a canceled delayed reply is discarded without replaying the request',
  { timeout: 5000 },
  async t => {
    const { proxy, received } = await fixture(t)
    proxy.rule = () => 'delay-response'
    const controller = new AbortController()
    const rejected = assert.rejects(
      fetch(`${proxy.url}/api/plugins/installed`, { signal: controller.signal })
    )
    await until(
      () => proxy.requests[0]?.delayedResponseReady,
      Boolean,
      'Real response was not retained',
      2000
    )
    controller.abort()
    await rejected
    await until(
      () => proxy.delayedResponses.size,
      count => count === 0,
      'Canceled response was retained',
      2000
    )
    assert.equal(proxy.releaseDelayedResponses(), 0)
    assert.equal(received.length, 1)
  }
)

test(
  'device transport pause holds real upstream bytes and resumes them unchanged',
  { timeout: 5000 },
  async t => {
    const { proxy, server } = await fixture(t)
    let upstream
    server.on('upgrade', (_request, socket) => {
      upstream = socket
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
      )
    })
    const client = connect(new URL(proxy.url).port, '127.0.0.1')
    t.after(() => client.destroy())
    await once(client, 'connect')
    const handshake = once(client, 'data')
    client.write(
      'GET /socket.io/?transport=websocket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    )
    assert.match(String((await handshake)[0]), /101 Switching Protocols/)
    assert.equal(proxy.websockets.size, 1)
    proxy.pauseDeviceDelivery(true)
    const chunks = []
    client.on('data', chunk => chunks.push(chunk))
    upstream.write('real-capability-sync')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(chunks.length, 0)
    const delivered = once(client, 'data')
    proxy.pauseDeviceDelivery(false)
    await delivered
    assert.equal(Buffer.concat(chunks).toString(), 'real-capability-sync')
  }
)
