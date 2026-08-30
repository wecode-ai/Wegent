import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  LocalEndpointEventByteStream,
  LocalEndpointEventStream,
} from './local-endpoint-event-stream.js'

test('subscribes to executor events from the requested sequence', async () => {
  const fixture = await eventServerFixture()
  const received = []
  let closed = false
  const stream = new LocalEndpointEventStream({
    endpoint: fixture.endpoint,
    token: fixture.token,
    afterSequence: 42,
    replayExisting: true,
    onEvent: event => received.push(event),
    onClose: () => {
      closed = true
    },
  })
  try {
    await stream.start()
    await waitFor(() => received.length === 1)

    assert.equal(fixture.authentication.event_stream, true)
    assert.equal(fixture.authentication.after_sequence, 42)
    assert.equal(fixture.authentication.replay_existing, true)
    assert.equal(received[0].sequence, 43)
    assert.equal(closed, false)
  } finally {
    stream.stop()
    await fixture.stop()
  }
})

test('fails stalled authentication with a retryable timeout', async () => {
  const fixture = await eventServerFixture({ respondToAuthentication: false })
  const stream = new LocalEndpointEventByteStream({
    endpoint: fixture.endpoint,
    token: fixture.token,
    afterSequence: 0,
    authenticationTimeoutMs: 20,
  })
  try {
    await assert.rejects(stream.start(), error => {
      assert.equal(error.code, 'authentication_timeout')
      assert.equal(error.retryable, true)
      return true
    })
  } finally {
    stream.stop()
    await fixture.stop()
  }
})

async function eventServerFixture({ respondToAuthentication = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-executor-events-'))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-executor-events-${process.pid}-${Date.now()}`
      : join(directory, 'executor.sock')
  const token = '0123456789abcdef0123456789abcdef'
  let authentication = null
  const clients = new Set()
  const server = createServer(socket => {
    clients.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        authentication = JSON.parse(line)
        if (!respondToAuthentication) continue
        socket.write(
          `${JSON.stringify({ type: 'authenticated', ok: true, protocol_version: 1 })}\n`
        )
        socket.write(
          `${JSON.stringify({
            type: 'event',
            protocolVersion: 1,
            sequence: 43,
            emittedAt: '2026-08-26T00:00:00.000Z',
            event: 'response.output_text.delta',
            payload: { data: { delta: 'resumed' } },
          })}\n`
        )
      }
    })
    socket.on('close', () => clients.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  return {
    endpoint,
    token,
    get authentication() {
      return authentication
    },
    async stop() {
      for (const client of clients) client.destroy()
      await new Promise(resolve => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for executor event')
}
