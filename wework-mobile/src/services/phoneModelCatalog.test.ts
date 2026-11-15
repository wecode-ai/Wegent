import { beforeEach, expect, it, vi } from 'vitest'
import { createDefaultLocalModelCatalogEntry } from '../../../wework/src/features/model-settings/localModelCatalog'
import { PhoneLocalModelStore } from './phoneLocalModels'
import { phoneModelProviders } from './phoneModelProviders'

const state = vi.hoisted(() => ({ values: new Map<string, string>(), id: 0 }))
vi.mock('expo-crypto', () => ({ randomUUID: () => `model-${++state.id}` }))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => state.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    state.values.set(key, value)
  },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
}))
beforeEach(() => {
  state.values.clear()
  state.id = 0
})
it('combines independent and provider models without rewriting either configuration', async () => {
  const store = new PhoneLocalModelStore()
  const old = await store.save({
    displayName: 'Standalone',
    modelId: 'old-upstream',
    baseUrl: 'https://proxy.test/prefix/v1/responses?region=cn',
    apiKey: 'old-key',
  })
  const oldRaw = state.values.get('wework.mobile.responses-models.v1')
  const snapshot = await phoneModelProviders.saveProvider(
    {
      id: 'service',
      name: 'Work',
      api_format: 'openai-chat-completions',
      base_url: 'https://proxy.test/v1',
      api_key: 'new-key',
      models: [{ id: 'new-model', model_id: 'new-upstream' }],
    },
    (await phoneModelProviders.providers()).revision
  )
  const providerRaw = state.values.get('wework.mobile.model-providers.v1')
  const runtime = { request: vi.fn().mockResolvedValue({ restarted: true }) }
  await store.sync(runtime)
  const models = runtime.request.mock.calls.find(
    call => call[0] === 'runtime.runner.local_models.replace'
  )![1].models
  expect(models.map((model: { model_id: string }) => model.model_id)).toEqual([
    `local-model:${old.id}`,
    'local-model:new-model',
  ])
  expect(models[0].modelConfig).toMatchObject({
    api_key: 'old-key',
    responses_url: 'https://proxy.test/prefix/v1/responses?region=cn',
  })
  expect(models[1].modelConfig).toMatchObject({
    api_key: 'new-key',
    upstream_api_format: 'openai-chat-completions',
  })
  expect(runtime.request.mock.lastCall?.[0]).toBe('runtime.models.sync_creation_profiles')
  expect(state.values.get('wework.mobile.responses-models.v1')).toBe(oldRaw)
  expect(state.values.get('wework.mobile.model-providers.v1')).toBe(providerRaw)
  await phoneModelProviders.removeProvider('service', snapshot.revision)
  await store.sync(runtime)
  expect(
    runtime.request.mock.calls
      .filter(call => call[0] === 'runtime.runner.local_models.replace')
      .at(-1)![1]
      .models.map((model: { model_id: string }) => model.model_id)
  ).toEqual([`local-model:${old.id}`])
  expect(await store.list()).toEqual([old])
  expect(state.values.get('wework.mobile.responses-models.v1')).toBe(oldRaw)
})
it('does not read or change standalone records while configuring providers', async () => {
  state.values.set('wework.mobile.responses-models.v1', '{unreadable-standalone')
  await phoneModelProviders.saveProvider(
    {
      id: 'service',
      name: 'Service',
      base_url: 'https://proxy.test/v1',
      api_format: 'openai-responses',
      models: [],
    },
    (await phoneModelProviders.providers()).revision
  )
  expect(state.values.get('wework.mobile.responses-models.v1')).toBe('{unreadable-standalone')
})

it('registers custom capability metadata, verifies an idle restart and preserves active tasks', async () => {
  const store = new PhoneLocalModelStore()
  await phoneModelProviders.saveProvider(
    {
      id: 'service',
      name: 'Work',
      base_url: 'https://proxy.test/v1',
      api_format: 'openai-responses',
      models: [
        {
          id: 'new-model',
          model_id: 'upstream',
          catalog_entry: {
            ...createDefaultLocalModelCatalogEntry({
              id: 'new-model',
              displayName: 'Upstream',
              toolProfile: 'function',
              contextWindow: 128000,
            }),
            supported_reasoning_levels: [{ effort: 'high', description: 'High' }],
          },
        },
      ],
    },
    (await phoneModelProviders.providers()).revision
  )
  const runtime = {
    request: vi
      .fn()
      .mockImplementation(async (method: string) =>
        method === 'runtime.codex.app_server.restart'
          ? { restarted: false, activeTaskCount: 1 }
          : {}
      ),
  }
  await expect(store.sync(runtime)).rejects.toThrow('执行器正忙')
  expect(runtime.request).toHaveBeenCalledWith('runtime.codex.catalog.custom.write', {
    models: [expect.objectContaining({ slug: 'wework-custom-new-model', context_window: 128000 })],
  })
  expect(runtime.request).toHaveBeenCalledWith('runtime.codex.app_server.restart', { ifIdle: true })
  expect(
    runtime.request.mock.calls.some(call => call[0] === 'runtime.models.sync_creation_profiles')
  ).toBe(false)
  // Existing independently configured models remain usable while the new catalog is pending.
  await store.sync(runtime, 'local-model:standalone')
  expect(runtime.request.mock.lastCall?.[0]).toBe('runtime.models.sync_creation_profiles')
  runtime.request.mockImplementation(async (method: string) =>
    method === 'runtime.codex.app_server.restart' ? { restarted: true } : {}
  )
  await store.sync(runtime, 'local-model:new-model')
  const restarts = runtime.request.mock.calls.filter(
    call => call[0] === 'runtime.codex.app_server.restart'
  ).length
  await store.sync(runtime, 'local-model:new-model')
  expect(
    runtime.request.mock.calls.filter(call => call[0] === 'runtime.codex.app_server.restart')
  ).toHaveLength(restarts)
})
