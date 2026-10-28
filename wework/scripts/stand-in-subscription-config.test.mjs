import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { readRequestBody } from '../e2e/desktop/modules/response-protocol.mjs'
import { createSubscriptionConfigRegression } from '../e2e/desktop/modules/stand-in-subscription-config.mjs'

class UpgradeSocket extends EventEmitter {
  destroyed = false
  response = ''

  end(value) {
    this.response = value
    return this
  }

  destroy() {
    this.destroyed = true
    return this
  }
}

async function withFallbackServer(run) {
  const fixture = createSubscriptionConfigRegression()
  const errors = []
  const sockets = new Set()
  const server = createServer((request, response) => {
    void readRequestBody(request)
      .then(body => {
        assert.equal(fixture.acceptsModelRequest(request, new URL(request.url, origin), body), true)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ accepted: true }))
      })
      .catch(error => {
        errors.push(error)
        response.writeHead(500)
        response.end(error.message)
      })
  })
  server.on('error', error => errors.push(error))
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  fixture.attachServer(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    await run({ fixture, server, origin })
    assert.deepEqual(errors, [], 'Unexpected model transport errors must fail the regression')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await fixture.cleanup()
  }
}

test('a real upgrade receives 426 and HTTP fallback retains subscription account and model checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subscription-fallback-'))
  try {
    await withFallbackServer(async ({ fixture, origin }) => {
      await writeFile(join(root, 'config.toml'), '')
      await fixture.prepareApp({
        appEnvironment: {},
        codexHome: root,
        control: { url: origin },
      })
      const config = await readFile(join(root, 'config.toml'), 'utf8')
      const bootstrap = config.match(/chatgpt_base_url = "([^"]+)"/)[1]
      const account = await fetch(`${bootstrap}wham/accounts/check`)
      assert.equal((await account.json()).accounts[0].id, 'stand-in-config-e2e')
      const status = await new Promise((resolve, reject) => {
        const request = httpRequest(
          `${origin}/backend-api/codex/responses?transport=websocket`,
          { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } },
          response => {
            response.resume()
            response.once('end', () => resolve(response.statusCode))
          }
        )
        request.once('error', reject)
        request.end()
      })
      assert.equal(status, 426)
      const response = await fetch(`${origin}/backend-api/codex/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer synthetic-subscription-access',
          'chatgpt-account-id': 'stand-in-config-e2e',
        },
        body: JSON.stringify({ model: 'gpt-5.5' }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { accepted: true })
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a real local Socket may cancel while the fixture closes its 426 upgrade', async () => {
  await withFallbackServer(async ({ server, origin }) => {
    const client = createConnection(new URL(origin).port, '127.0.0.1')
    const clientErrors = []
    client.on('error', error => clientErrors.push(error))
    try {
      await once(client, 'connect')
      const upgraded = new Promise(resolve => {
        server.once('upgrade', (_request, socket) => {
          assert.ok(socket.listenerCount('error') > 0, 'The owned upgrade must handle cancellation')
          resolve({ closed: new Promise(closed => socket.once('close', closed)) })
        })
      })
      const clientClosed = new Promise(resolve => client.once('close', resolve))
      client.write(
        'GET /backend-api/codex/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
      )
      const { closed } = await upgraded
      client.resetAndDestroy()
      await Promise.all([closed, clientClosed])
      assert.deepEqual(clientErrors, [])
    } finally {
      client.destroy()
    }
  })
})

test.each(['ECONNRESET', 'EPIPE'])('the owned 426 close tolerates only expected %s', code => {
  const server = new EventEmitter()
  createSubscriptionConfigRegression().attachServer(server)
  const socket = new UpgradeSocket()
  server.emit('upgrade', { url: '/backend-api/codex/responses' }, socket)

  assert.match(socket.response, /^HTTP\/1\.1 426 Upgrade Required/)
  socket.emit('error', Object.assign(new Error('peer cancelled'), { code }))
  assert.equal(socket.destroyed, true)
})

test('unknown upgrade errors remain hard failures', () => {
  const server = new EventEmitter()
  createSubscriptionConfigRegression().attachServer(server)
  const socket = new UpgradeSocket()
  server.emit('upgrade', { url: '/backend-api/codex/responses' }, socket)
  const failure = Object.assign(new Error('unexpected transport failure'), { code: 'EIO' })

  assert.throws(
    () => socket.emit('error', failure),
    error => error === failure
  )
  assert.equal(socket.destroyed, true)
})

test.each(['/v1/responses', '/backend-api/codex/responses-other'])(
  'closes every upgrade %s owned by the HTTP listener with an explicit 426',
  url => {
    const server = new EventEmitter()
    createSubscriptionConfigRegression().attachServer(server)
    const socket = new UpgradeSocket()

    server.emit('upgrade', { url }, socket)

    assert.equal(socket.listenerCount('error'), 1)
    assert.match(socket.response, /^HTTP\/1\.1 426 Upgrade Required/)
    assert.equal(socket.destroyed, false)
  }
)

test('a reset before the intentional 426 close remains a hard failure', () => {
  const failure = Object.assign(new Error('unexpected early reset'), { code: 'ECONNRESET' })
  class EarlyResetSocket extends UpgradeSocket {
    on(event, listener) {
      super.on(event, listener)
      if (event === 'error') listener(failure)
      return this
    }
  }
  const server = new EventEmitter()
  createSubscriptionConfigRegression().attachServer(server)
  const socket = new EarlyResetSocket()

  assert.throws(
    () => server.emit('upgrade', { url: '/backend-api/codex/responses' }, socket),
    error => error === failure
  )
  assert.equal(socket.destroyed, true)
  assert.equal(socket.response, '')
})
