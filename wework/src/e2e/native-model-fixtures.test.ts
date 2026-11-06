import { beforeEach, expect, test, vi } from 'vitest'
import { readNativeModelFixtures, writeNativeModelFixtures } from './native-model-fixtures'
import {
  clearLocalModelConfigs,
  listLegacyLocalModelConfigs,
} from '@/features/model-settings/localModelSettings'
import { replaceProviderModelConfigs } from '@/features/model-settings/providerModelState'
import type { ModelProvider } from '@/features/model-settings/providerModelConfiguration'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: invoke,
  subscribeDesktopHostEvents: vi.fn(),
}))

beforeEach(() => {
  clearLocalModelConfigs()
  replaceProviderModelConfigs([])
  invoke.mockReset()
})

test('writes fixture updates through native model ownership and refreshes the real projection', async () => {
  let providers: ModelProvider[] = []
  let revision = 'old'
  invoke.mockImplementation(async (method, params) => {
    if (method === 'modelConfiguration.read') return { providers, revision }
    if (method === 'modelConfiguration.save') {
      expect(params.revision).toBe(revision)
      providers = params.providers
      revision = 'new'
      return { providers, revision }
    }
    if (method === 'modelConfiguration.runtime')
      return {
        revision,
        models: providers.flatMap(provider => provider.models.map(model => ({ provider, model }))),
      }
    throw new Error(`Unexpected native method: ${method}`)
  })
  await writeNativeModelFixtures([
    {
      id: 'fixture',
      modelId: 'upstream',
      displayName: 'Fixture',
      baseUrl: 'https://fixture.example',
      apiFormat: 'openai-responses',
      toolProfile: 'function',
      apiKey: 'synthetic-fixture-key',
      webSearchMode: 'disabled',
      imageGenerationEnabled: false,
      enabled: true,
      catalogReady: false,
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ])
  expect(readNativeModelFixtures()).toEqual([
    expect.objectContaining({ id: 'fixture', providerConnectionId: providers[0].id }),
  ])
  expect(listLegacyLocalModelConfigs()).toEqual([])
  expect(invoke.mock.calls.map(call => call[0])).toEqual([
    'modelConfiguration.read',
    'modelConfiguration.save',
    'modelConfiguration.read',
    'modelConfiguration.runtime',
  ])
})

test('rejects a native owner error instead of publishing a renderer-only fixture', async () => {
  invoke.mockResolvedValue({ providers: [], revision: 'bad', error: 'Owner unavailable' })
  await expect(writeNativeModelFixtures([])).rejects.toThrow('Owner unavailable')
  expect(readNativeModelFixtures()).toEqual([])
  expect(invoke).toHaveBeenCalledTimes(1)
})
