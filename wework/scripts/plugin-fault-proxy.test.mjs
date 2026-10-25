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
    response.writeHead(request.method === 'DELETE' ? 204 : 200, {
      'Content-Type': 'text/plain',
    })
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
  'dropped POST response commits once and permits an explicit retry without retaining credentials',
  { timeout: 5000 },
  async t => {
    const { proxy, received } = await fixture(t)
    proxy.rule = request => (request.method === 'POST' ? 'drop-response' : null)
    const post = () =>
      fetch(`${proxy.url}/api/plugins/installed?device_id=private`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: 'credential-body',
      })
    const dropped = await post()
    assert.equal(dropped.status, 200)
    assert.equal(dropped.headers.get('content-type'), 'text/plain')
    await assert.rejects(dropped.text())
    assert.equal(received.length, 1)
    assert.equal(received[0].method, 'POST')
    assert.equal(proxy.requests.length, 1)
    assert.equal(proxy.requests[0].status, 200)
    assert.equal(proxy.requests[0].committedResponseDropped, true)
    proxy.rule = () => null
    const response = await post()
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'real-upstream-body')
    assert.equal(received.filter(request => request.method === 'POST').length, 2)
    assert.equal(proxy.requests[1].status, 200)
    assert.equal(proxy.requests[1].committedResponseDropped, undefined)
    assert.ok(!/secret|private|credential-body/.test(JSON.stringify(proxy.requests)))
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
  const response = await fetch(`${proxy.url}/snapshot`)
  assert.equal(response.status, 200)
  await assert.rejects(response.text())
  assert.equal(proxy.requests[0].status, 200)
  assert.equal(proxy.requests[0].dropped, true)
  assert.equal(proxy.requests[0].committedResponseDropped, true)
  assert.equal(received.length, 1)
})

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

test(
  'device acknowledgement pause holds real device bytes while downstream delivery stays live',
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
    await handshake
    proxy.pauseDeviceAcknowledgements(true)
    const chunks = []
    upstream.on('data', chunk => chunks.push(chunk))
    client.write('real-device-ack')
    const delivery = once(client, 'data')
    upstream.write('real-package-delivery')
    assert.equal(String((await delivery)[0]), 'real-package-delivery')
    assert.equal(chunks.length, 0)
    const acknowledgement = once(upstream, 'data')
    proxy.pauseDeviceAcknowledgements(false)
    await acknowledgement
    assert.equal(Buffer.concat(chunks).toString(), 'real-device-ack')
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
      fetch(`${proxy.url}${path}?project_id=project`, { signal: controller.signal }).then(
        response => response.text()
      )
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

function websocketFrame(text, { opcode = 1, final = true, masked = false, wide = false } = {}) {
  const payload = Buffer.from(text)
  const extended = wide ? 8 : payload.length >= 126 ? 2 : 0
  const header = Buffer.alloc(2 + extended + (masked ? 4 : 0))
  header[0] = (final ? 128 : 0) | opcode
  header[1] = (masked ? 128 : 0) | (wide ? 127 : extended ? 126 : payload.length)
  if (wide) header.writeBigUInt64BE(BigInt(payload.length), 2)
  else if (extended) header.writeUInt16BE(payload.length, 2)
  if (masked) {
    const offset = 2 + extended
    header.set([17, 29, 31, 43], offset)
    for (let index = 0; index < payload.length; index += 1)
      payload[index] ^= header[offset + (index % 4)]
  }
  return Buffer.concat([header, payload])
}

for (const encoding of ['ordinary', 'wide', 'fragmented']) {
  test(
    `capability gate reorders real ${encoding} frames and observes only the matching ACK without changing bytes`,
    { timeout: 5000 },
    async t => {
      const { proxy, server } = await fixture(t)
      const gate = proxy.holdNextCapabilitySync(payload => !payload.scope)
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
      await handshake
      const chunks = []
      client.on('data', chunk => chunks.push(chunk))
      const metadata = { version: 2, generation: 7, complete: true }
      const registration = `42/local-executor,17${JSON.stringify([
        'device:sync_capabilities',
        {
          plugin_sync: metadata,
          plugins: [],
          skills: [{ name: 'fixture' }],
          private: 'must-not-record'.repeat(12),
        },
      ])}`
      const frames =
        encoding === 'fragmented'
          ? [
              websocketFrame(registration.slice(0, 51), { final: false }),
              websocketFrame(registration.slice(51), { opcode: 0 }),
            ]
          : [websocketFrame(registration, { wide: encoding === 'wide' })]
      const ping = websocketFrame('keepalive', { opcode: 9 })
      const later = websocketFrame(
        '42/local-executor,18["device:sync_capabilities",{"scope":"plugins"}]'
      )
      // Split a frame header across TCP chunks, then coalesce its tail with later frames.
      upstream.write(frames[0].subarray(0, 1))
      upstream.write(Buffer.concat([frames[0].subarray(1), ping, ...frames.slice(1), later]))
      await until(() => gate.held, Boolean, 'Registration was not held', 2000)
      await until(
        () => Buffer.concat(chunks).length,
        size => size === ping.length + later.length,
        'Later frames were blocked',
        2000
      )
      assert.deepEqual(Buffer.concat(chunks), Buffer.concat([ping, later]))
      assert.deepEqual(gate.held, { scope: 'all', pluginSync: metadata })
      const deviceBytes = []
      upstream.on('data', chunk => deviceBytes.push(chunk))
      const unrelated = websocketFrame('43/local-executor,18[{"success":true}]', { masked: true })
      client.write(unrelated)
      await until(
        () => Buffer.concat(deviceBytes).length,
        size => size === unrelated.length,
        'Device ACK was blocked',
        2000
      )
      assert.equal(gate.acknowledgement, null)
      assert.deepEqual(Buffer.concat(deviceBytes), unrelated)
      gate.release()
      gate.release()
      await until(
        () => Buffer.concat(chunks).length,
        size =>
          size ===
          ping.length + later.length + frames.reduce((size, frame) => size + frame.length, 0),
        'Held frames were not released',
        2000
      )
      assert.deepEqual(Buffer.concat(chunks), Buffer.concat([ping, later, ...frames]))
      const acknowledgement = websocketFrame(
        `43/local-executor,17${JSON.stringify([
          {
            success: true,
            scope: 'all',
            plugin_sync: metadata,
            skills: [{ name: 'fixture', status: 'synced', private: 'must-not-record' }],
            credentials: 'must-not-record',
          },
        ])}`,
        { masked: true }
      )
      client.write(acknowledgement)
      await until(() => gate.acknowledgement, Boolean, 'Matching real ACK was not observed', 2000)
      await until(
        () => Buffer.concat(deviceBytes).length,
        size => size === unrelated.length + acknowledgement.length,
        'Matching ACK bytes were not forwarded',
        2000
      )
      assert.deepEqual(Buffer.concat(deviceBytes), Buffer.concat([unrelated, acknowledgement]))
      assert.deepEqual(gate.acknowledgement, {
        success: true,
        scope: 'all',
        pluginSync: metadata,
        skills: [{ name: 'fixture', status: 'synced' }],
        mcps: [],
      })
      assert.ok(!JSON.stringify([gate.held, gate.acknowledgement]).includes('must-not-record'))
      assert.equal(gate.error, undefined)
    }
  )
}
