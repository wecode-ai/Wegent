import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { test } from 'vitest'
import { createCatalogContextVerification } from '../e2e/desktop/scenarios/codex-catalog-context.mjs'

async function fixture(t) {
  const server = createServer()
  createCatalogContextVerification({ modelId: 'gpt-5.5' }).attachServer(server)
  const upgraded = new Promise(resolve => {
    server.prependOnceListener('upgrade', (_request, socket) => resolve(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = connect(server.address().port, '127.0.0.1')
  client.on('error', error => {
    if (error.code !== 'ECONNRESET') throw error
  })
  let socket
  t.onTestFinished(async () => {
    client.destroy()
    socket?.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  const response = new Promise(resolve => client.once('data', data => resolve(data.toString())))
  client.write(
    'GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
  )
  socket = await upgraded
  return { server, socket, response }
}

test('rejects model WebSocket upgrades with HTTP 426', async t => {
  const { response } = await fixture(t)
  assert.equal(
    await response,
    'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
  )
})

test('owns reset errors on a rejected upgrade socket', async t => {
  const { socket } = await fixture(t)
  const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  assert.doesNotThrow(() => socket.emit('error', error))
  assert.equal(socket.destroyed, true)
})

test('preserves unexpected upgrade errors as server failures', async t => {
  const { server, socket } = await fixture(t)
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  let failure
  server.once('error', error => {
    failure = error
  })
  socket.emit('error', error)
  assert.equal(failure, error)
  assert.equal(socket.destroyed, true)
})
