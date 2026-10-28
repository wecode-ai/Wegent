import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { onTestFinished, test } from 'vitest'
import { createCatalogContextVerification } from '../e2e/desktop/scenarios/codex-catalog-context.mjs'
import { createSubscriptionConfigRegression } from '../e2e/desktop/modules/stand-in-subscription-config.mjs'

const regressions = [
  {
    name: 'catalog',
    path: '/v1/responses',
    create: () => createCatalogContextVerification({ modelId: 'gpt-5.5' }),
  },
  {
    name: 'subscription',
    path: '/backend-api/codex/responses',
    create: createSubscriptionConfigRegression,
  },
  {
    name: 'subscription unrelated upgrade',
    path: '/socket.io/?EIO=4&transport=websocket',
    create: createSubscriptionConfigRegression,
  },
]

async function fixture(regression) {
  const server = createServer()
  regression.create().attachServer(server)
  const upgraded = new Promise(resolve => {
    server.prependOnceListener('upgrade', (_request, socket) => resolve(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = connect(server.address().port, '127.0.0.1')
  client.on('error', error => {
    if (error.code !== 'ECONNRESET') throw error
  })
  let socket
  onTestFinished(async () => {
    client.destroy()
    socket?.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  const response = new Promise(resolve => client.once('data', data => resolve(data.toString())))
  client.write(
    `GET ${regression.path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
  )
  socket = await upgraded
  return { server, socket, response }
}

test.each(regressions)('$name rejects model WebSocket upgrades with HTTP 426', async regression => {
  const { response } = await fixture(regression)
  assert.equal(
    await response,
    'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
  )
})

test.each(regressions)('$name owns reset errors on a rejected upgrade socket', async regression => {
  const { socket } = await fixture(regression)
  const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  assert.doesNotThrow(() => socket.emit('error', error))
  assert.equal(socket.destroyed, true)
})

test.each(regressions)(
  '$name preserves unexpected upgrade errors as server failures',
  async regression => {
    const { server, socket } = await fixture(regression)
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    let failure
    server.once('error', error => {
      failure = error
    })
    socket.emit('error', error)
    assert.equal(failure, error)
    assert.equal(socket.destroyed, true)
  }
)
