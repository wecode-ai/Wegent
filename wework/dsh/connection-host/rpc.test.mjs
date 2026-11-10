import assert from 'node:assert/strict'
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

test('only collection errors expose a bounded retry delay without adding retries', async () => {
  for (const method of ['collect', 'readSource', 'executeAction', 'initialize', 'catalog']) {
    const result = await invoke({
      body: { method },
      failure: Object.assign(new Error('Transient read failure'), {
        code: 'example_transport_failed',
        retryAfterMs: 45000,
      }),
    })
    assert.equal(result.calls, 1)
    assert.equal(result.response.error.retryAfterMs, method === 'collect' ? 45000 : undefined)
  }
  for (const retryAfterMs of [0, -1, 3600001, 1.5, '30000', null]) {
    const result = await invoke({
      body: { method: 'collect' },
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
      body: { method: 'collect' },
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

test('native CLI classification and cause survive the client and collection RPC without replay', async () => {
  for (const method of ['collect', 'executeAction']) {
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
    assert.equal(result.response.error.retryAfterMs, method === 'collect' ? 30000 : undefined)
  }
  for (const providerCode of ['private token', 'invalid\ncode', 'x'.repeat(65)]) {
    const result = await invoke({
      body: { method: 'collect' },
      failure: Object.assign(new Error('Failed'), {
        code: 'connection_cli_request_failed',
        providerCode,
      }),
    })
    assert.equal(result.response.error.providerCode, undefined)
  }
})
