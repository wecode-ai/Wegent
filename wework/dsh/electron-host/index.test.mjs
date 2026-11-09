import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { apply, hostDisconnectHandler } from './index.js'
import { ElectronHostClient } from './electron-host-client.js'

test('authenticates the registered host routes before any capability dispatch', async t => {
  let invocations = 0
  const routes = new Map()
  const cleanups = []
  t.mock.method(ElectronHostClient, 'fromEnvironment', () => ({
    start: async () => {},
    stop() {},
    describe: () => ({
      protocolVersion: 1,
      capabilities: ['app.getVersion', 'secureStorage.get', 'secureStorage.set'],
    }),
    invoke: async () => {
      invocations += 1
      return { version: 'test' }
    },
  }))
  await apply({
    connection: {
      requestRejection: req => (req.headers.cookie === 'session=valid' ? undefined : 401),
    },
    webServer: {
      port: 3000,
      register: route => {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    reflect: { provide: () => () => {} },
    get: () => () => {},
    effect: factory => cleanups.push(factory()),
  })
  t.after(() => cleanups.reverse().forEach(cleanup => cleanup?.()))
  for (const [path, handler] of routes) {
    for (const [host, cookie, expected] of [
      ['rebind.attacker.test:3000', 'session=valid', 403],
      ['127.0.0.1:3000', undefined, 401],
      ['127.0.0.1:3000', 'session=valid', 200],
    ]) {
      const req = Readable.from([JSON.stringify({ capability: 'app.getVersion', params: {} })])
      req.method = path.endsWith('/invoke') ? 'POST' : 'GET'
      req.socket = { remoteAddress: '127.0.0.1' }
      req.headers = { host, origin: `http://${host}`, cookie }
      let status
      let body
      await handler(req, {
        writeHead: value => {
          status = value
        },
        end(value) {
          body = value
        },
      })
      assert.equal(status, expected, `${path} / ${host}`)
      if (status === 200 && !path.endsWith('/invoke')) {
        assert.deepEqual(JSON.parse(body).capabilities, ['app.getVersion'])
      }
    }
  }
  assert.equal(invocations, 1)
})

test('requests bounded DSH exit when the Electron host disconnects', () => {
  const exits = []
  const disconnect = hostDisconnectHandler({
    get(name) {
      assert.equal(name, 'appExit')
      return code => exits.push(code)
    },
  })

  disconnect()

  assert.deepEqual(exits, [0])
})

test('denies secret reads, writes and deletes over HTTP even for authenticated same-origin requests', async t => {
  const routes = new Map()
  const cleanups = []
  let invocations = 0
  t.mock.method(ElectronHostClient, 'fromEnvironment', () => ({
    start: async () => {},
    stop() {},
    describe: () => ({ protocolVersion: 1, capabilities: [] }),
    invoke: async () => {
      invocations += 1
    },
  }))
  await apply({
    connection: { requestRejection: () => undefined },
    webServer: {
      port: 3000,
      register: route => {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    reflect: { provide: () => () => {} },
    get: () => () => {},
    effect: factory => cleanups.push(factory()),
  })
  t.after(() => cleanups.reverse().forEach(cleanup => cleanup?.()))
  for (const operation of ['get', 'set', 'delete']) {
    const req = Readable.from([
      JSON.stringify({
        capability: `secureStorage.${operation}`,
        params: { key: 'model.key', value: 'replacement' },
      }),
    ])
    req.method = 'POST'
    req.socket = { remoteAddress: '127.0.0.1' }
    req.headers = {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      cookie: 'session=valid',
    }
    let status
    let response
    await routes.get('/wework/electron-host/v1/invoke')(req, {
      writeHead: value => {
        status = value
      },
      end: value => {
        response = JSON.parse(value)
      },
    })
    assert.equal(status, 403)
    assert.equal(response.error.code, 'capability_denied')
  }
  assert.equal(invocations, 0)
})

test('requires the launcher exit service', () => {
  assert.throws(
    () => hostDisconnectHandler({ get: () => undefined }),
    /requires the DSH launcher appExit service/
  )
})
