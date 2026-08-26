import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadClient(fetchImpl) {
  let factory
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  const window = {
    fetch: fetchImpl,
    __ModuleLoader__: {
      load(entry) {
        factory = entry.factory
      },
    },
  }
  vm.runInNewContext(source, { window, Error, Object, String, JSON })
  assert.equal(typeof factory, 'function')
  return factory()
}

function jsonResponse(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  }
}

test('provides one Renderer service backed by the same-origin host route', async () => {
  const requests = []
  const client = await loadClient(async (url, init) => {
    requests.push({ url, init })
    if (init.method === 'GET') {
      return jsonResponse(200, {
        protocolVersion: 1,
        capabilities: ['app.getVersion', 'rendererHealth.getState'],
      })
    }
    const body = JSON.parse(init.body)
    return jsonResponse(200, {
      ok: true,
      result: { capability: body.capability, params: body.params },
    })
  })
  const generation = client.createWeworkDesktopClient()

  assert.deepEqual(
    JSON.parse(JSON.stringify(await generation.service.describe())),
    {
      protocolVersion: 1,
      capabilities: ['app.getVersion', 'rendererHealth.getState'],
    }
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(await generation.service.shell.openExternal('https://example.com'))),
    {
      capability: 'shell.openExternal',
      params: { url: 'https://example.com' },
    }
  )
  assert.equal(requests[0].url, '/wework/electron-host/v1')
  assert.equal(requests[0].init.credentials, 'same-origin')
  assert.equal(requests[1].url, '/wework/electron-host/v1/invoke')
})

test('preserves structured Host errors and rejects retained generation references', async () => {
  const client = await loadClient(async () =>
    jsonResponse(403, {
      ok: false,
      error: {
        code: 'capability_denied',
        message: 'Denied',
        details: { capability: 'window.close' },
      },
    })
  )
  const failed = client.createWeworkDesktopClient()
  await assert.rejects(
    () => failed.service.window.close(),
    error =>
      error.code === 'capability_denied' &&
      error.details.capability === 'window.close'
  )

  const disposed = client.createWeworkDesktopClient()
  disposed.dispose()
  await assert.rejects(
    () => disposed.service.window.getState(),
    error => error.code === 'service_disposed'
  )
})

test('registers and disposes the Renderer Cordis service with its generation', async () => {
  const client = await loadClient(async () => jsonResponse(200, {}))
  let provided
  let disposeEffect
  client.apply({
    effect(factory, label) {
      assert.equal(label, 'wework-electron-host: renderer desktop service generation')
      disposeEffect = factory()
    },
    provide(name, service) {
      provided = { name, service }
      return () => {}
    },
  })

  assert.equal(provided.name, 'weworkDesktop')
  assert.equal(typeof provided.service.rendererHealth.getState, 'function')
  disposeEffect()
  await assert.rejects(
    () => provided.service.describe(),
    error => error.code === 'service_disposed'
  )
})

test('exports package metadata required by the DSH client registry', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('./package.json', import.meta.url), 'utf8')
  )
  assert.equal(packageJson.exports['./client'], './client.js')
  assert.equal(packageJson.exports['./package.json'], './package.json')
  assert.equal(packageJson.dsh.client.platform, 'web')
})
