// @vitest-environment node

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resolveProviderModel } from '@/features/model-settings/providerModelConfiguration'
import {
  getProviderModelConfigs,
  replaceProviderModelConfigs,
} from '@/features/model-settings/providerModelState'
import * as diagnostics from '@/lib/model-loading-diagnostics'
import { createLocalAppServices, resetLocalRuntimeChatStreamsForTests } from './localServices'

vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: vi.fn().mockResolvedValue({ localCodexSubscriptionEnabled: false }),
}))
vi.mock('@/desktop/systemProxy', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/systemProxy')>()),
  resolveLocalCodexProxyUrl: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/model-loading-diagnostics', () => ({
  createModelLoadingTrace: () => 'catalog-trace',
  logModelLoading: vi.fn(),
  traceModelLoading: (_traceId: string, _stage: string, operation: () => Promise<unknown>) =>
    operation(),
}))

beforeEach(() => {
  replaceProviderModelConfigs([])
  resetLocalRuntimeChatStreamsForTests()
  vi.clearAllMocks()
})

afterEach(() => replaceProviderModelConfigs([]))

async function deferredProviderCatalog(
  gate: 'activeTask' | 'backgroundTerminal',
  recovery: 'idle' | 'loaded'
) {
  const provider = {
    id: 'private-provider',
    name: 'Private provider',
    base_url: 'https://private.example/v1',
    api_format: 'openai-responses' as const,
    api_key: 'private-key',
  }
  const previous = {
    ...resolveProviderModel({ provider, model: { id: 'model-b', model_id: 'private-model-b' } }),
    catalogReady: true,
  }
  const saved = resolveProviderModel({
    provider,
    model: { id: 'model-c', model_id: 'private-model-c' },
  })
  let recovered = false
  const request = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(
    async method => {
      if (method === 'runtime.codex.app_server.restart') {
        return {
          restarted: recovered && recovery === 'idle',
          activeTaskCount: !recovered && gate === 'activeTask' ? 1 : 0,
          backgroundTerminalCount: !recovered && gate === 'backgroundTerminal' ? 1 : 0,
          pendingRequestCount: 0,
        }
      }
      if (method === 'runtime.codex.models.list') {
        return {
          data: [previous, ...(recovered ? [saved] : [])].map(model => ({
            id: model.codexCatalogModelId,
          })),
        }
      }
      return {}
    }
  )
  const services = createLocalAppServices({
    ensure: vi.fn().mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'local-device',
      runtimeInstanceId: 'runtime-1',
    }),
    request,
    subscribe: vi.fn(),
  })
  replaceProviderModelConfigs([previous])
  const initial = await services.modelApi.listModels()
  replaceProviderModelConfigs([previous, saved])
  const deferred = await services.modelApi.listModels()
  const pending = getProviderModelConfigs().find(model => model.id === saved.id)
  const deferredDiagnostics = vi.mocked(diagnostics.logModelLoading).mock.calls.slice()
  recovered = true
  const activated = await services.modelApi.listModels()
  return { initial, deferred, activated, pending, request, deferredDiagnostics }
}

test.each([
  ['activeTask', 'idle'],
  ['activeTask', 'loaded'],
  ['backgroundTerminal', 'idle'],
  ['backgroundTerminal', 'loaded'],
] as const)(
  'a saved provider model remains pending behind the %s gate until the next %s owner request',
  async (gate, recovery) => {
    const { initial, deferred, activated, pending, request } = await deferredProviderCatalog(
      gate,
      recovery
    )

    expect(initial.data.map(model => model.name)).toEqual(['local-model:model-b'])
    expect(deferred.data.map(model => model.name)).toEqual(['local-model:model-b'])
    expect(pending).toMatchObject({ id: 'model-c', catalogReady: false })
    expect(activated.data.map(model => model.name)).toEqual([
      'local-model:model-b',
      'local-model:model-c',
    ])
    expect(getProviderModelConfigs().find(model => model.id === 'model-c')?.catalogReady).toBe(true)
    const restarts = request.mock.calls.filter(
      ([method]) => method === 'runtime.codex.app_server.restart'
    )
    expect(restarts.length).toBeGreaterThan(0)
    for (const restart of restarts) {
      expect(restart).toEqual(['runtime.codex.app_server.restart', { ifIdle: true }])
    }
  }
)

test('records only numeric catalog readiness and native restart gates', async () => {
  const { deferredDiagnostics } = await deferredProviderCatalog('backgroundTerminal', 'idle')

  expect(deferredDiagnostics).toContainEqual([
    'catalog-trace',
    'catalog.reconciliation.restart',
    {
      restarted: false,
      activeTaskCount: 0,
      backgroundTerminalCount: 1,
      pendingRequestCount: 0,
    },
  ])
  expect(deferredDiagnostics).toContainEqual([
    'catalog-trace',
    'catalog.reconciliation.loaded',
    { attempt: 1, loadedModelCount: 1, matchedPendingCount: 0, pendingModelCount: 1 },
  ])
  expect(deferredDiagnostics).toContainEqual([
    'catalog-trace',
    'catalog.readiness',
    { configuredModelCount: 2, enabledModelCount: 2, readyModelCount: 1, pendingModelCount: 1 },
  ])
  for (const [, , details] of deferredDiagnostics) {
    expect(
      Object.values(details ?? {}).every(value => ['number', 'boolean'].includes(typeof value))
    ).toBe(true)
  }
  const serialized = JSON.stringify(deferredDiagnostics)
  for (const privateValue of ['private-', 'model-b', 'model-c', 'local-device', 'runtime-1']) {
    expect(serialized).not.toContain(privateValue)
  }
})
