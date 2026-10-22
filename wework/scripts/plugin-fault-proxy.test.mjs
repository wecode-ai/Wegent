import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { test } from 'vitest'
import { TransportFaultProxy } from '../e2e/desktop/modules/transport-fault-proxy.mjs'
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
  const proxy = await new TransportFaultProxy(`http://127.0.0.1:${server.address().port}`).start()
  t.onTestFinished(async () => {
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
      headers: { Authorization: 'Bearer secret' },
    })
    assert.equal(await response.text(), 'real-upstream-body')
    assert.equal(received.length, 1)
    assert.equal(proxy.requests[0].unscoped, false)
    assert.ok(!JSON.stringify(proxy.requests).includes('secret'))
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
  'releases the first real response after a later response without changing either body',
  { timeout: 5000 },
  async t => {
    const { proxy, received } = await fixture(t)
    proxy.rule = entry => (entry.path === '/first' ? 'hold-response' : null)
    let completed = false
    const first = fetch(`${proxy.url}/first`).then(async response => {
      completed = true
      return response.text()
    })
    await until(
      () => proxy.requests[0]?.committedResponseHeld,
      Boolean,
      'First response was not held',
      2000
    )
    assert.equal(await (await fetch(`${proxy.url}/second`)).text(), 'real-upstream-body')
    assert.equal(completed, false)
    await proxy.requests[0].release()
    assert.equal(await first, 'real-upstream-body')
    assert.equal(received.length, 2)
  }
)

test('drops a real response after upstream completion', { timeout: 5000 }, async t => {
  const { proxy, received } = await fixture(t)
  proxy.rule = () => 'drop-response'
  await assert.rejects(fetch(`${proxy.url}/snapshot`))
  assert.equal(proxy.requests[0].status, 200)
  assert.equal(proxy.requests[0].dropped, true)
  assert.equal(received.length, 1)
})

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
    t.onTestFinished(() => client.destroy())
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

for (const fault of ['drop-response', 'hold-response']) {
  test(`native ${fault} assertions reject early and unscoped scans`, { timeout: 5000 }, async t => {
    const { assertNativeCatalogRequests, nativeCatalogFault, hasScopedNativeFault } =
      await import('../e2e/desktop/modules/agent-catalog-regressions.mjs')
    const { proxy } = await fixture(t)
    const path = '/api/v1/resources/execution-environments'
    proxy.rule = entry => nativeCatalogFault(entry, fault)
    // Inject the early full-catalog request that previously made this E2E pass.
    await (await fetch(`${proxy.url}${path}`)).text()
    assert.equal(proxy.requests[0].fault, null)
    assert.equal(hasScopedNativeFault(proxy.requests, fault), false)
    assert.throws(() => assertNativeCatalogRequests(proxy.requests, true), /unscoped/)
    assert.throws(() => assertNativeCatalogRequests(proxy.requests), /unscoped/)

    const preflight = await fetch(`${proxy.url}${path}?project_id=project`, { method: 'OPTIONS' })
    assert.equal(await preflight.text(), 'real-upstream-body')
    assert.equal(proxy.requests.at(-1).fault, null)
    assert.equal(hasScopedNativeFault(proxy.requests, fault), false)

    const start = proxy.requests.length
    const controller = new AbortController()
    const pending = assert.rejects(
      fetch(`${proxy.url}${path}?project_id=project`, { signal: controller.signal })
    )
    await until(
      () => proxy.requests.slice(start),
      entries => hasScopedNativeFault(entries, fault),
      'The scoped native response did not hit the injected fault',
      2000
    )
    const scoped = proxy.requests.slice(start)
    assert.throws(() => assertNativeCatalogRequests(scoped, true), /before selecting a device/)
    assert.doesNotThrow(() => assertNativeCatalogRequests(scoped))
    controller.abort()
    await pending
    assert.equal(hasScopedNativeFault([{ ...scoped[0], unscoped: true }], fault), false)
    assert.equal(hasScopedNativeFault([{ ...scoped[0], method: 'OPTIONS' }], fault), false)
  })
}

test('a reset destructive request never reaches the upstream and an explicit retry can recover', async t => {
  const { proxy, received } = await fixture(t)
  proxy.rule = () => 'reset-request'
  await assert.rejects(fetch(`${proxy.url}/api/teams/1`, { method: 'DELETE' }))
  assert.equal(received.length, 0)
  proxy.rule = () => null
  const response = await fetch(`${proxy.url}/api/teams/1`, { method: 'DELETE' })
  assert.equal(response.status, 204)
  assert.deepEqual(received, [{ method: 'DELETE', url: '/api/teams/1' }])
})
