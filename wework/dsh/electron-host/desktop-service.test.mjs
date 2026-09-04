import assert from 'node:assert/strict'
import test from 'node:test'
import { ElectronHostError } from './electron-host-client.js'
import { createWeworkDesktopService } from './desktop-service.js'

test('maps the typed desktop service to narrow Electron capabilities', async () => {
  const invocations = []
  const client = {
    describe: () => ({
      protocolVersion: 1,
      capabilities: ['window.getState', 'rendererHealth.getState'],
    }),
    invoke: async (capability, params) => {
      invocations.push({ capability, params })
      return { capability }
    },
  }
  const generation = createWeworkDesktopService(client)

  assert.deepEqual(await generation.service.window.getState(), {
    capability: 'window.getState',
  })
  assert.deepEqual(await generation.service.rendererHealth.getState(), {
    capability: 'rendererHealth.getState',
  })
  await generation.service.shell.openExternal('https://example.com')
  await generation.service.preferences.update({ appearanceMode: 'dark' })
  await generation.service.weworkSync.request({
    apiBaseUrl: 'https://cloud.example.com/api',
    path: '/wework-transcripts',
    method: 'GET',
  })
  assert.deepEqual(invocations, [
    { capability: 'window.getState', params: {} },
    { capability: 'rendererHealth.getState', params: {} },
    {
      capability: 'shell.openExternal',
      params: { url: 'https://example.com' },
    },
    {
      capability: 'preferences.update',
      params: { patch: { appearanceMode: 'dark' } },
    },
    {
      capability: 'weworkSync.request',
      params: {
        apiBaseUrl: 'https://cloud.example.com/api',
        path: '/wework-transcripts',
        method: 'GET',
      },
    },
  ])
})

test('rejects references retained after the owning DSH generation is disposed', async () => {
  const generation = createWeworkDesktopService({
    describe: () => ({ protocolVersion: 1, capabilities: [] }),
    invoke: async () => null,
  })
  const retainedWindow = generation.service.window

  generation.dispose()

  await assert.rejects(
    () => retainedWindow.getState(),
    error => error instanceof ElectronHostError && error.code === 'service_disposed'
  )
  await assert.rejects(
    () => generation.service.describe(),
    error => error instanceof ElectronHostError && error.code === 'service_disposed'
  )
})
