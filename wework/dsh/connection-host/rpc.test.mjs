import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { handleConnectionRpc } from './rpc.js'

async function invoke({
  authorization = 'Bearer secret',
  remoteAddress = '127.0.0.1',
  body = { method: 'catalog' },
  method = 'POST',
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

test('does not execute a provider on unsupported HTTP methods', async () => {
  const result = await invoke({ method: 'GET' })
  assert.equal(result.status, 405)
  assert.equal(result.calls, 0)
})
