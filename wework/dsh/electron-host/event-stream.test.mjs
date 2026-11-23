import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import WebSocket from 'ws'
import { registerHostEventStream } from './event-stream.js'
import { createRequestSecurity } from './request-security.js'

test('authenticates event upgrades and delivers replay without HTTP polling', async t => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const received = []
  const security = createRequestSecurity(
    {
      requestRejection: req => (req.headers.cookie === 'session=valid' ? undefined : 401),
    },
    port
  )
  const dispose = registerHostEventStream(
    {
      webServer: {
        registerUpgrade({ handler }) {
          server.on('upgrade', handler)
          return () => server.off('upgrade', handler)
        },
      },
    },
    security,
    {
      invoke(capability, params) {
        received.push({ capability, params })
        return received.length === 1
          ? Promise.resolve({
              events: [{ sequence: 8, type: 'systemDrag.pending', payload: {} }],
              latestSequence: 8,
              historyLost: false,
            })
          : new Promise(() => {})
      },
    },
    '/events'
  )
  t.after(() => {
    dispose()
    server.close()
  })
  const endpoint = `ws://127.0.0.1:${port}/events?after=7`
  const denied = new WebSocket(endpoint, { origin: `http://127.0.0.1:${port}` })
  const error = once(denied, 'error')
  assert.match((await error)[0].message, /401/)
  assert.equal(received.length, 0)
  const socket = new WebSocket(endpoint, {
    origin: `http://127.0.0.1:${port}`,
    headers: { cookie: 'session=valid' },
  })
  t.after(() => socket.terminate())
  const message = await once(socket, 'message')
  assert.equal(JSON.parse(message[0]).events[0].sequence, 8)
  assert.deepEqual(received[0], { capability: 'desktop.events', params: { after: 7, wait: true } })
  assert.deepEqual(received[1], { capability: 'desktop.events', params: { after: 8, wait: true } })
})
