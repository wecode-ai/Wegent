import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { once } from 'node:events'
import { ExecutorRuntimeClient, ExecutorRuntimeError } from './executor-runtime-client.js'
import { LocalEndpointTransport } from './local-endpoint-transport.js'

test('preserves only bounded collection retry metadata from native responses', () => {
  const client = new ExecutorRuntimeClient({ transport: { on() {} } })
  for (const retryAfterMs of [30000, 3600000, 0, -1, 3600001, '30000']) {
    let observed
    let cleanupCount = 0
    client.pending.set('retry', {
      cleanup() {
        cleanupCount++
      },
      reject: error => {
        observed = error
      },
    })
    client.handleMessage({
      type: 'response',
      id: 'retry',
      ok: false,
      error: { code: 'native_failure', message: 'Failed', retryAfterMs },
    })
    assert.equal(cleanupCount, 1)
    assert.equal(client.pending.has('retry'), false)
    assert.equal(
      observed.retryAfterMs,
      [30000, 3600000].includes(retryAfterMs) ? retryAfterMs : undefined
    )
    assert.equal(observed.retryable, false, 'Metadata does not authorize an operation retry')
  }
})

test('negotiates local endpoint RPC without owning event history', async () => {
  const fixture = await executorFixture()
  const client = new ExecutorRuntimeClient({
    transport: new LocalEndpointTransport({
      endpoint: fixture.endpoint,
      token: fixture.token,
      reconnectDelayMs: 10,
    }),
  })
  try {
    await client.start()
    assert.equal(client.describe().protocol_version, 1)
    assert.deepEqual(await client.request('executor.health'), { healthy: true })
    assert.equal(client.replay, undefined)
    assert.equal(client.listen, undefined)
    assert.deepEqual(await client.request('codex.app_server_request'), { healthy: true })
    assert.throws(
      () => client.request('untrusted.execute'),
      error => error instanceof ExecutorRuntimeError && error.code === 'method_not_allowed'
    )
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

test('rejects an invalid local endpoint credential', async () => {
  const fixture = await executorFixture()
  const transport = new LocalEndpointTransport({
    endpoint: fixture.endpoint,
    token: 'wrong-wrong-wrong-wrong-wrong-wrong',
    reconnectDelayMs: 10,
  })
  try {
    await assert.rejects(transport.start(), /authentication failed/i)
  } finally {
    await transport.stop()
    await fixture.stop()
  }
})

test('waits for the local endpoint during parallel executor startup', async () => {
  const fixture = await executorFixture({ startListening: false })
  const client = new ExecutorRuntimeClient({
    transport: new LocalEndpointTransport({
      endpoint: fixture.endpoint,
      token: fixture.token,
      reconnectDelayMs: 10,
      startTimeoutMs: 1_000,
    }),
  })
  try {
    const start = client.start()
    await new Promise(resolve => setTimeout(resolve, 30))
    await fixture.listen()
    await start

    assert.equal(client.describe().device_id, 'local-device')
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

test('reconnects and renegotiates after the local endpoint disconnects', async () => {
  const fixture = await executorFixture({ descriptionDelayMs: 50 })
  const transport = new LocalEndpointTransport({
    endpoint: fixture.endpoint,
    token: fixture.token,
    reconnectDelayMs: 10,
  })
  const client = new ExecutorRuntimeClient({
    transport,
  })
  try {
    await client.start()
    fixture.disconnect()
    await waitFor(() => fixture.connectionCount() >= 2 && transport.authenticated)
    assert.deepEqual(await client.request('executor.health'), { healthy: true })
    assert.equal(client.describe().device_id, 'local-device')
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

test('reports disconnection before negotiation as retryable readiness instead of permission denial', async () => {
  const fixture = await executorFixture()
  const transport = new LocalEndpointTransport({
    endpoint: fixture.endpoint,
    token: fixture.token,
    reconnectDelayMs: 200,
  })
  const client = new ExecutorRuntimeClient({ transport })
  try {
    await client.start()
    const disconnected = once(transport, 'close')
    fixture.disconnect()
    await disconnected
    await assert.rejects(
      async () => client.request('executor.health'),
      error =>
        error instanceof ExecutorRuntimeError &&
        error.code === 'runtime_not_ready' &&
        error.retryable
    )
    await waitFor(() => fixture.connectionCount() >= 2 && transport.authenticated)
    assert.deepEqual(await client.request('executor.health'), { healthy: true })
    assert.throws(() => client.request('untrusted.execute'), { code: 'method_not_allowed' })
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

test('decodes compressed local endpoint responses without disconnecting', async () => {
  const fixture = await executorFixture({ compressedHealthResponse: true })
  const client = new ExecutorRuntimeClient({
    transport: new LocalEndpointTransport({
      endpoint: fixture.endpoint,
      token: fixture.token,
      reconnectDelayMs: 10,
    }),
  })
  try {
    await client.start()
    assert.deepEqual(await client.request('executor.health'), {
      healthy: true,
      payload: 'x'.repeat(2 * 1024 * 1024),
    })
    assert.equal(fixture.connectionCount(), 1)
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

test('uses a caller-provided request id for downstream log correlation', async () => {
  const fixture = await executorFixture()
  const client = new ExecutorRuntimeClient({
    transport: new LocalEndpointTransport({
      endpoint: fixture.endpoint,
      token: fixture.token,
      reconnectDelayMs: 10,
    }),
  })
  try {
    await client.start()
    await client.request('executor.health', {}, undefined, 'wework-local-request-1')
    assert.equal(fixture.lastRequestId(), 'wework-local-request-1')
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

test('rejects a duplicate caller-provided request id while the first request is in flight', async () => {
  const fixture = await executorFixture({ healthResponseDelayMs: 25 })
  const client = new ExecutorRuntimeClient({
    transport: new LocalEndpointTransport({
      endpoint: fixture.endpoint,
      token: fixture.token,
      reconnectDelayMs: 10,
    }),
  })
  try {
    await client.start()
    const firstRequest = client.request('executor.health', {}, undefined, 'wework-local-request-1')

    await assert.rejects(
      client.request('executor.health', {}, undefined, 'wework-local-request-1'),
      error => error instanceof ExecutorRuntimeError && error.code === 'duplicate_request_id'
    )
    await assert.doesNotReject(firstRequest)
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

test('aborts a read on the same socket without interrupting unrelated control requests', async () => {
  const fixture = await executorFixture({ holdHistoryReads: true })
  const client = new ExecutorRuntimeClient({
    transport: new LocalEndpointTransport({ endpoint: fixture.endpoint, token: fixture.token }),
  })
  try {
    await client.start()
    const controller = new AbortController()
    const read = client.request('runtime.tasks.transcript', {}, undefined, 'cancelled-read', {
      signal: controller.signal,
    })
    const rejected = assert.rejects(read, { code: 'request_cancelled' })
    await waitFor(() => fixture.heldRequestIds().includes('cancelled-read'))
    controller.abort()
    await rejected
    await waitFor(() => fixture.cancelledIds().includes('cancelled-read'))
    assert.deepEqual(await client.request('executor.health'), { healthy: true })
    assert.equal(client.pending.size, 0)
    assert.equal(fixture.connectionCount(), 1)
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

test('read timeout cancels executor work and pre-aborted reads never reach the socket', async () => {
  const fixture = await executorFixture({ holdHistoryReads: true })
  const client = new ExecutorRuntimeClient({
    transport: new LocalEndpointTransport({ endpoint: fixture.endpoint, token: fixture.token }),
  })
  try {
    await client.start()
    await assert.rejects(client.request('runtime.tasks.transcript', {}, 20, 'timed-out-read'), {
      code: 'request_timeout',
    })
    await waitFor(() => fixture.cancelledIds().includes('timed-out-read'))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      client.request('runtime.tasks.transcript', {}, undefined, 'never-sent', {
        signal: controller.signal,
      }),
      { code: 'request_cancelled' }
    )
    await client.request('executor.health')
    assert.ok(!fixture.requestIds().includes('never-sent'))
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

test('an abort signal never cancels a mutating request', async () => {
  const fixture = await executorFixture({ holdSends: true })
  const client = new ExecutorRuntimeClient({
    transport: new LocalEndpointTransport({ endpoint: fixture.endpoint, token: fixture.token }),
  })
  try {
    await client.start()
    const controller = new AbortController()
    const send = client.request('runtime.tasks.send', {}, undefined, 'accepted-send', {
      signal: controller.signal,
    })
    await waitFor(() => fixture.heldRequestIds().includes('accepted-send'))
    controller.abort()
    assert.deepEqual(await client.request('executor.health'), { healthy: true })
    assert.deepEqual(fixture.cancelledIds(), [])
    fixture.release('accepted-send')
    await assert.doesNotReject(send)
  } finally {
    await client.stop()
    await fixture.stop()
  }
})

async function executorFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-executor-runtime-'))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-executor-runtime-${process.pid}-${Date.now()}`
      : join(directory, 'executor.sock')
  const token = '0123456789abcdef0123456789abcdef'
  const clients = new Set()
  let connectionCount = 0
  let lastRequestId = null
  const requestIds = []
  const cancelledIds = []
  const heldRequests = new Map()
  let listening = false
  const server = createServer(socket => {
    connectionCount += 1
    clients.add(socket)
    socket.setEncoding('utf8')
    let authenticated = false
    let buffered = ''
    socket.on('data', chunk => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (!authenticated) {
          authenticated =
            message.type === 'authenticate' &&
            message.protocol_version === 1 &&
            message.token === token
          socket.write(
            `${JSON.stringify(
              authenticated
                ? { type: 'authenticated', ok: true, protocol_version: 1 }
                : {
                    type: 'authenticated',
                    ok: false,
                    error: { message: 'Local executor authentication failed' },
                  }
            )}\n`
          )
          if (!authenticated) socket.end()
          continue
        }
        if (message.type === 'cancel') {
          cancelledIds.push(message.id)
          heldRequests.delete(message.id)
          continue
        }
        if (message.method === 'executor.protocol.describe') {
          setTimeout(() => {
            socket.write(
              `${JSON.stringify({
                type: 'response',
                id: message.id,
                ok: true,
                result: {
                  protocol_version: 1,
                  device_id: 'local-device',
                  capabilities: ['executor.health'],
                  renderer_methods: [
                    'codex.app_server_request',
                    'executor.health',
                    'runtime.tasks.*',
                  ],
                  transports: ['local-endpoint-ndjson'],
                  features: {
                    request_response: true,
                    events: true,
                    structured_errors: true,
                    compressed_responses: true,
                    event_resume: false,
                  },
                },
              })}\n`
            )
          }, options.descriptionDelayMs ?? 0)
        } else {
          lastRequestId = message.id
          requestIds.push(message.id)
          if (
            (options.holdHistoryReads && message.method.startsWith('runtime.tasks.transcript')) ||
            (options.holdSends && message.method === 'runtime.tasks.send')
          ) {
            heldRequests.set(message.id, socket)
            continue
          }
          const result = options.compressedHealthResponse
            ? {
                __runtimeRpcEncoding: 'gzip+base64+json',
                payload: gzipSync(
                  JSON.stringify({
                    healthy: true,
                    payload: 'x'.repeat(2 * 1024 * 1024),
                  })
                ).toString('base64'),
              }
            : { healthy: true }
          setTimeout(() => {
            socket.write(
              `${JSON.stringify({
                type: 'response',
                id: message.id,
                ok: true,
                result,
              })}\n`
            )
          }, options.healthResponseDelayMs ?? 0)
        }
      }
    })
    socket.on('close', () => clients.delete(socket))
  })
  const listen = async () => {
    if (listening) return
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    listening = true
  }
  if (options.startListening !== false) await listen()
  return {
    endpoint,
    token,
    requestIds: () => [...requestIds],
    heldRequestIds: () => [...heldRequests.keys()],
    cancelledIds: () => [...cancelledIds],
    release(id) {
      const socket = heldRequests.get(id)
      assert.ok(socket, 'held request must exist')
      heldRequests.delete(id)
      socket.write(
        `${JSON.stringify({ type: 'response', id, ok: true, result: { accepted: true } })}\n`
      )
    },
    listen,
    broadcast(message) {
      for (const client of clients) {
        client.write(`${JSON.stringify(message)}\n`)
      }
    },
    connectionCount() {
      return connectionCount
    },
    lastRequestId() {
      return lastRequestId
    },
    disconnect() {
      for (const client of clients) client.destroy()
    },
    async stop() {
      for (const client of clients) client.destroy()
      if (listening) await new Promise(resolve => server.close(resolve))
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
