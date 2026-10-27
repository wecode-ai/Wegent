import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import test from 'node:test'

import { RuntimeEventProxy } from '../e2e/desktop/modules/runtime-event-proxy.mjs'

const completed = {
  type: 'event',
  event: 'response.completed',
  payload: { taskId: 'task-one', subtaskId: 'turn-one', eventSeq: 12, data: { value: 'Final' } },
}
const packet = envelope => `42/local-executor,["runtime:event",${JSON.stringify(envelope)}]`

// Deliberately fixed masks make byte-for-byte forwarding assertions reproducible.
function clientFrame(text, { opcode = 1, final = true } = {}) {
  const body = Buffer.from(text)
  assert.ok(body.length < 0x10000)
  const header = body.length < 126 ? Buffer.from([0, body.length | 0x80]) : Buffer.alloc(4)
  header[0] = (final ? 0x80 : 0) | opcode
  if (header.length === 4) {
    header[1] = 0xfe
    header.writeUInt16BE(body.length, 2)
  }
  const mask = Buffer.from([0x19, 0x54, 0x71, 0x23])
  for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4]
  return Buffer.concat([header, mask, body])
}

function frameText(frame) {
  const offset = (frame[1] & 0x7f) === 126 ? 4 : 2
  const mask = frame.subarray(offset, offset + 4)
  const body = Buffer.from(frame.subarray(offset + 4))
  for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4]
  return body.toString('utf8')
}

function serverFrame(text) {
  const body = Buffer.from(text)
  assert.ok(body.length < 126)
  return Buffer.concat([Buffer.from([0x81, body.length]), body])
}

async function fixture(t) {
  const sockets = new Set()
  let received = Buffer.alloc(0)
  let downstreamReceived = Buffer.alloc(0)
  let authentication
  let backendSocket
  let incoming = Buffer.alloc(0)
  const packets = []
  const acknowledgements = []
  let acknowledge = true
  let ackSuccess = true
  let proxy
  let client
  const backend = createServer((request, response) => {
    authentication = request.headers.authorization
    request.pipe(response)
  })
  t.after(async () => {
    client?.destroy()
    await proxy?.stop()
    for (const socket of sockets) socket.destroy()
    if (backend.listening) {
      await new Promise((resolve, reject) =>
        backend.close(error => (error ? reject(error) : resolve()))
      )
    }
  })
  backend.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  backend.on('upgrade', (request, socket) => {
    backendSocket = socket
    authentication = request.headers.authorization
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk])
      incoming = Buffer.concat([incoming, chunk])
      while (incoming.length >= 2) {
        const lengthCode = incoming[1] & 0x7f
        const headerLength = lengthCode === 126 ? 4 : 2
        if (incoming.length < headerLength) break
        const payloadLength = lengthCode === 126 ? incoming.readUInt16BE(2) : lengthCode
        const length = headerLength + 4 + payloadLength
        if (incoming.length < length) break
        const frame = incoming.subarray(0, length)
        incoming = incoming.subarray(length)
        const text = frameText(frame)
        packets.push(text)
        const match = /^42\/local-executor,(\d+)(\[.*)$/s.exec(text)
        if (match) {
          const ack = () =>
            socket.write(serverFrame(`43/local-executor,${match[1]}[{"success":${ackSuccess}}]`))
          acknowledgements.push(ack)
          if (acknowledge) ack()
        }
      }
    })
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  proxy = await new RuntimeEventProxy(`http://127.0.0.1:${backend.address().port}`).start()
  client = connect(new URL(proxy.url).port, '127.0.0.1')
  let upgraded = false
  const readiness = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Proxy WebSocket handshake timed out')), 2_000)
    client.on('error', reject)
    client.on('close', () => {
      if (!upgraded) reject(new Error('Proxy socket closed before WebSocket upgrade'))
    })
    client.on('data', chunk => {
      downstreamReceived = Buffer.concat([downstreamReceived, chunk])
      if (!upgraded) {
        const boundary = downstreamReceived.indexOf('\r\n\r\n')
        if (boundary === -1) return
        clearTimeout(timer)
        const headers = downstreamReceived.subarray(0, boundary).toString()
        if (!/^HTTP\/1.1 101 /.test(headers)) {
          reject(new Error('Proxy WebSocket upgrade was rejected'))
          return
        }
        downstreamReceived = downstreamReceived.subarray(boundary + 4)
        upgraded = true
        resolve()
      }
    })
    t.after(() => clearTimeout(timer))
  })
  client.write(
    `GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer fixture-auth\r\n\r\n`
  )
  await readiness
  return {
    proxy,
    client,
    backend,
    received: () => received,
    downstreamReceived: () => downstreamReceived,
    backendSocket: () => backendSocket,
    authentication: () => authentication,
    packets,
    acknowledgements,
    setAcknowledge: value => (acknowledge = value),
    setAckSuccess: value => (ackSuccess = value),
  }
}

async function until(predicate) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Network operation did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('holds only selected Runtime events while auth, RPC and both directions stay real', async t => {
  const network = await fixture(t)
  const { proxy, client } = network
  assert.equal(network.authentication(), 'Bearer fixture-auth')
  proxy.hold = envelope => envelope.event === 'response.completed'
  const terminal = clientFrame(packet(completed))
  const rpc = clientFrame('43/local-executor,7[{"ok":true}]')
  const created = clientFrame(packet({ ...completed, event: 'response.created' }))
  const heartbeat = clientFrame('2')
  const observed = proxy.waitForEvent(entry => entry.event === 'response.completed')
  client.write(Buffer.concat([terminal, rpc, created, heartbeat]))
  const entry = await observed
  const bypass = Buffer.concat([rpc, created, heartbeat])
  await until(() => network.received().length >= bypass.length)
  assert.deepEqual(network.received(), bypass)
  assert.deepEqual(entry.envelope, completed)
  assert.equal(entry.held, true)
  assert.equal(entry.deliveries, 0)

  // A genuine upstream frame is also forwarded while the terminal event is held.
  const upstreamFrame = Buffer.from([0x81, 1, 0x32])
  network.backendSocket().write(upstreamFrame)
  await until(() => network.downstreamReceived().length === upstreamFrame.length)
  assert.deepEqual(network.downstreamReceived(), upstreamFrame)

  await proxy.release(entry)
  assert.deepEqual(JSON.parse(network.packets.at(-1).slice(network.packets.at(-1).indexOf('['))), [
    'runtime:event',
    completed,
  ])
  assert.equal(
    network.downstreamReceived().length,
    upstreamFrame.length,
    'Proxy ACK leaked to client'
  )
  assert.equal(entry.deliveries, 1)
  assert.equal(entry.held, false)
  await proxy.replay(entry)
  const releases = network.packets.filter(text => /^42\/local-executor,\d+\[/.test(text))
  assert.equal(releases.length, 2)
  assert.notEqual(releases[0], releases[1], 'Each delivery needs an independent backend ACK')
  assert.deepEqual(JSON.parse(releases[1].slice(releases[1].indexOf('['))), [
    'runtime:event',
    completed,
  ])
  assert.equal(entry.deliveries, 2)
})

test('recognizes split and fragmented Runtime messages without blocking WebSocket control frames', async t => {
  const network = await fixture(t)
  const { proxy, client } = network
  proxy.hold = () => true
  const text = packet(completed)
  const first = clientFrame(text.slice(0, 60), { final: false })
  const ping = clientFrame('ping', { opcode: 9 })
  const final = clientFrame(text.slice(60), { opcode: 0 })
  client.write(first.subarray(0, 1))
  client.write(first.subarray(1))
  client.write(ping)
  await until(() => network.received().length === ping.length)
  assert.deepEqual(network.received(), ping)
  client.write(final)
  const entry = await proxy.waitForEvent(value => value.held)
  assert.deepEqual(entry.envelope, completed)
  await proxy.release(entry)
  const terminalPacket = network.packets.find(text => text.startsWith('42/local-executor,'))
  assert.deepEqual(JSON.parse(terminalPacket.slice(terminalPacket.indexOf('['))), [
    'runtime:event',
    completed,
  ])
})

test('replays a captured identity with missing sequencing or empty final data', async t => {
  const network = await fixture(t)
  network.proxy.hold = () => true
  network.client.write(clientFrame(packet(completed)))
  const entry = await network.proxy.waitForEvent(value => value.held)
  await network.proxy.replay(entry, { eventSeq: undefined, data: {} })
  await until(() => network.received().length > 0)
  const text = network.packets.at(-1)
  const decoded = JSON.parse(text.slice(text.indexOf('[')))
  assert.deepEqual(decoded, [
    'runtime:event',
    { ...completed, payload: { taskId: 'task-one', subtaskId: 'turn-one', data: {} } },
  ])
  assert.equal(entry.held, true, 'Replaying a variant must not release the held original')
  assert.deepEqual(entry.envelope, completed, 'Captured evidence must remain unchanged')
})

test('release waits for the real upstream ACK and rejects a backend failure', async t => {
  const network = await fixture(t)
  network.proxy.hold = () => true
  network.setAcknowledge(false)
  network.client.write(clientFrame(packet(completed)))
  const entry = await network.proxy.waitForEvent(value => value.held)
  let settled = false
  const released = network.proxy.release(entry).then(() => (settled = true))
  await until(() => network.acknowledgements.length === 1)
  assert.equal(settled, false, 'Writing the socket must not count as backend processing')
  network.acknowledgements[0]()
  await released
  assert.equal(settled, true)
  assert.equal(network.downstreamReceived().length, 0, 'Only proxy-owned ACKs must be consumed')

  const executorAck = serverFrame('43/local-executor,7[{"success":true}]')
  network.backendSocket().write(executorAck)
  await until(() => network.downstreamReceived().length === executorAck.length)
  assert.deepEqual(network.downstreamReceived(), executorAck)

  network.setAcknowledge(true)
  network.setAckSuccess(false)
  await assert.rejects(network.proxy.replay(entry), /Backend rejected/)
  assert.equal(entry.deliveries, 1, 'A rejected delivery must not be counted as successful')
})

test('event waits have a deadline and stopping rejects outstanding waits', async t => {
  const { proxy } = await fixture(t)
  await assert.rejects(
    proxy.waitForEvent(() => false, { timeoutMs: 10 }),
    /within 10ms/
  )
  const pending = assert.rejects(
    proxy.waitForEvent(() => false),
    /proxy stopped/
  )
  proxy.fail(new Error('Runtime event proxy stopped'))
  await pending
})
