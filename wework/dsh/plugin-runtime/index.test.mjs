import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply, BASE_PATH, handleRpc } from './index.js'

test('registers lifecycle-scoped plugin backend methods', async () => {
  let provided
  let ownerCleanup
  let runtimeCleanup
  let route
  const ctx = {
    effect(factory) {
      runtimeCleanup = factory()
    },
    reflect: {
      provide(name, service) {
        assert.equal(name, 'weworkPluginRuntime')
        provided = service
        return () => undefined
      },
    },
    webServer: {
      register(value) {
        route = value
        return () => undefined
      },
    },
  }
  const owner = {
    effect(factory) {
      ownerCleanup = factory()
    },
  }

  apply(ctx)
  provided.register(owner, {
    id: 'quality-guardian',
    methods: {
      scan: params => ({ cwd: params.cwd, issues: 3 }),
    },
  })

  assert.equal(route.path, BASE_PATH)
  const response = await invoke(route.handler, {
    plugin: 'quality-guardian',
    method: 'scan',
    params: { cwd: '/workspace' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    ok: true,
    result: { cwd: '/workspace', issues: 3 },
  })

  ownerCleanup()
  const missing = await invoke(route.handler, {
    plugin: 'quality-guardian',
    method: 'scan',
    params: { cwd: '/workspace' },
  })
  assert.equal(missing.status, 404)
  runtimeCleanup()
})

test('rejects duplicate backends and invalid methods', () => {
  let provided
  const owner = { effect() {} }
  apply({
    effect(factory) {
      factory()
    },
    reflect: {
      provide(_name, service) {
        provided = service
        return () => undefined
      },
    },
    webServer: {
      register() {
        return () => undefined
      },
    },
  })
  provided.register(owner, { id: 'plugin-a', methods: { run: () => null } })
  assert.throws(
    () => provided.register(owner, { id: 'plugin-a', methods: { run: () => null } }),
    /already registered/
  )
  assert.throws(
    () => provided.register(owner, { id: 'plugin-b', methods: { 'bad method': () => null } }),
    /must match/
  )
})

test('rejects non-loopback requests', async () => {
  const response = createResponse()
  const request = Readable.from([JSON.stringify({ plugin: 'a', method: 'b', params: {} })])
  request.method = 'POST'
  request.headers = {}
  request.socket = { remoteAddress: '10.0.0.8' }

  await handleRpc(request, response, async () => null)
  assert.equal(response.status, 403)
})

async function invoke(handler, body) {
  const response = createResponse()
  const request = Readable.from([JSON.stringify(body)])
  request.method = 'POST'
  request.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }
  request.socket = { remoteAddress: '127.0.0.1' }
  await handler(request, response)
  return response
}

function createResponse() {
  return {
    body: null,
    status: null,
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body ? JSON.parse(body) : null
    },
  }
}
