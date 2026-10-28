import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadClient(bridge) {
  let factory
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  const window = {
    weworkElectronHost: bridge,
    fetch() {
      throw new Error('HTTP must not be used')
    },
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

test('uses trusted preload IPC for every Renderer service', async () => {
  const requests = []
  const client = await loadClient({
    describe: async () => ({ protocolVersion: 1, capabilities: ['app.getVersion'] }),
    invoke: async (capability, params) => {
      requests.push({ capability, params })
      return { ok: true, result: { capability, params } }
    },
  })
  const generation = client.createWeworkDesktopClient()
  assert.equal((await generation.service.describe()).protocolVersion, 1)
  await generation.service.shell.openExternal('https://example.com')
  await generation.service.deviceDiagnostics.microphone()
  await generation.service.deviceDiagnostics.microphone({ inputDeviceKind: 'built-in' })
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { capability: 'shell.openExternal', params: { url: 'https://example.com' } },
    { capability: 'deviceDiagnostics.microphone', params: {} },
    { capability: 'deviceDiagnostics.microphone', params: { inputDeviceKind: 'built-in' } },
  ])
})

test('missing IPC never attempts an HTTP fallback', async () => {
  const client = await loadClient(undefined)
  await assert.rejects(() => client.createWeworkDesktopClient().service.app.getVersion(), {
    code: 'host_unavailable',
  })
})

test('preserves structured Host errors and rejects retained generation references', async () => {
  const client = await loadClient({
    invoke: async () => ({
      ok: false,
      error: {
        code: 'capability_denied',
        message: 'Denied',
        details: { capability: 'window.close' },
      },
    }),
  })
  const failed = client.createWeworkDesktopClient()
  await assert.rejects(
    () => failed.service.window.close(),
    error => error.code === 'capability_denied' && error.details.capability === 'window.close'
  )

  const disposed = client.createWeworkDesktopClient()
  disposed.dispose()
  await assert.rejects(
    () => disposed.service.deviceDiagnostics.microphone(),
    error => error.code === 'service_disposed'
  )
  await assert.rejects(
    () => disposed.service.window.getState(),
    error => error.code === 'service_disposed'
  )
})

test('registers and disposes the Renderer Cordis service with its generation', async () => {
  const client = await loadClient({
    describe: async () => ({}),
    invoke: async () => ({ ok: true }),
  })
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
  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.exports['./client'], './client.js')
  assert.equal(packageJson.exports['./package.json'], './package.json')
  assert.equal(packageJson.dsh.client.platform, 'web')
})
