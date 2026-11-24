import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { handleConnectionRpc } from './rpc.js'
import { ExecutorRuntimeClient } from '../executor-runtime/executor-runtime-client.js'

async function invoke({
  authorization = 'Bearer secret',
  remoteAddress = '127.0.0.1',
  body = { method: 'catalog' },
  method = 'POST',
  failure,
} = {}) {
  const req = Readable.from([JSON.stringify(body)])
  req.headers = { authorization }
  req.socket = { remoteAddress }
  req.method = method
  let status
  let response
  let calls = 0
  const res = {
    writeHead(value) {
      status = value
    },
    end(value) {
      response = JSON.parse(value)
    },
  }
  await handleConnectionRpc(req, res, 'secret', async () => {
    calls++
    if (failure) throw failure
    return { items: [] }
  })
  return { status, response, calls }
}

test('requires both loopback transport and the private host token', async () => {
  for (const options of [
    { authorization: '' },
    { authorization: 'Bearer wrong' },
    { remoteAddress: '10.0.0.1' },
  ]) {
    const result = await invoke(options)
    assert.equal(result.status, 403)
    assert.equal(result.calls, 0)
  }
  const accepted = await invoke()
  assert.equal(accepted.status, 200)
  assert.deepEqual(accepted.response, { ok: true, result: { items: [] } })
})

test(
  'returns 413 and closes the authenticated private HTTP connection',
  { timeout: 2000 },
  async t => {
    const closed = Promise.withResolvers()
    let calls = 0
    const server = createServer((req, res) => {
      req.socket.once('close', closed.resolve)
      return handleConnectionRpc(req, res, 'secret', () => calls++)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: new Uint8Array(1024 * 1024 + 1),
    })
    assert.equal(response.status, 413)
    assert.equal(response.headers.get('connection'), 'close')
    assert.equal((await response.json()).error.code, 'request_too_large')
    await closed.promise
    assert.equal(calls, 0)
  }
)

test('only collection errors expose a bounded retry delay without adding retries', async () => {
  for (const method of [
    'collectObservation',
    'readSource',
    'executeAction',
    'initialize',
    'catalog',
  ]) {
    const result = await invoke({
      body: { method },
      failure: Object.assign(new Error('Transient read failure'), {
        code: 'example_transport_failed',
        retryAfterMs: 45000,
      }),
    })
    assert.equal(result.calls, 1)
    assert.equal(
      result.response.error.retryAfterMs,
      method === 'collectObservation' ? 45000 : undefined
    )
  }
  for (const retryAfterMs of [0, -1, 3600001, 1.5, '30000', null]) {
    const result = await invoke({
      body: { method: 'collectObservation' },
      failure: Object.assign(new Error('Read failure'), { code: 'example_failed', retryAfterMs }),
    })
    assert.equal(result.response.error.retryAfterMs, undefined)
  }
  for (const code of [
    'connector_auth_required',
    'connection_response_invalid',
    'invalid_connection',
    'forbidden',
    'connection_tool_denied',
    'connection_cli_request_failed',
    'connection_cli_response_invalid',
  ]) {
    const result = await invoke({
      body: { method: 'collectObservation' },
      failure: Object.assign(new Error('Permanent'), { code, retryAfterMs: 30000 }),
    })
    assert.equal(result.response.error.retryAfterMs, undefined)
  }
})

test('does not execute a provider on unsupported HTTP methods', async () => {
  const result = await invoke({ method: 'GET' })
  assert.equal(result.status, 405)
  assert.equal(result.calls, 0)
})

test('disconnecting a collection cancels the provider before releasing its worker', async () => {
  const req = Readable.from([JSON.stringify({ method: 'collectObservation' })])
  req.headers = { authorization: 'Bearer secret' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.method = 'POST'
  const res = new EventEmitter()
  const started = Promise.withResolvers()
  const request = handleConnectionRpc(req, res, 'secret', async (_body, signal) => {
    assert.ok(signal)
    const cancelled = new Promise(resolve =>
      signal.addEventListener('abort', resolve, { once: true })
    )
    started.resolve()
    await cancelled
    signal.throwIfAborted()
  })
  await started.promise
  res.destroyed = true
  res.emit('close')
  await request
  assert.equal(res.listenerCount('close'), 0)
})

test('native CLI classification and cause survive the client and collection RPC without replay', async () => {
  for (const method of ['collectObservation', 'executeAction']) {
    const client = new ExecutorRuntimeClient({ transport: { on() {} } })
    let failure
    client.pending.set('failed-read', {
      cleanup() {},
      reject: error => {
        failure = error
      },
    })
    client.handleMessage({
      type: 'response',
      id: 'failed-read',
      ok: false,
      error: {
        code: 'connection_cli_request_unavailable',
        message: 'Plugin tool request failed (request_failed)',
        providerCode: 'request_failed',
        retryAfterMs: 30000,
      },
    })
    const result = await invoke({ body: { method }, failure })
    assert.equal(result.calls, 1)
    assert.equal(result.response.error.code, 'connection_cli_request_unavailable')
    assert.equal(result.response.error.providerCode, 'request_failed')
    assert.equal(
      result.response.error.retryAfterMs,
      method === 'collectObservation' ? 30000 : undefined
    )
  }
  for (const providerCode of ['private token', 'invalid\ncode', 'x'.repeat(65)]) {
    const result = await invoke({
      body: { method: 'collectObservation' },
      failure: Object.assign(new Error('Failed'), {
        code: 'connection_cli_request_failed',
        providerCode,
      }),
    })
    assert.equal(result.response.error.providerCode, undefined)
  }
})
