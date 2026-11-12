// @vitest-environment node

import { beforeEach, expect, test, vi } from 'vitest'
import type { ModelProvider } from './providerModelConfiguration'
import { testProviderConnection } from './providerConnectionTest'

const { invoke, probe } = vi.hoisted(() => ({ invoke: vi.fn(), probe: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: invoke }))
vi.mock('./localModelConnectionTest', () => ({ testLocalModelConnection: probe }))
const provider: ModelProvider = {
  id: 'relay',
  name: 'Relay',
  base_url: 'https://relay.example/v1',
  api_format: 'openai-responses',
  models: [{ id: 'first', model_id: 'upstream-a' }],
}
beforeEach(() => {
  vi.resetAllMocks()
  invoke.mockImplementation(async (_method, params) =>
    params.provider.models.map((model: { model_id: string }) => ({ model: model.model_id }))
  )
  probe.mockResolvedValue({ status: 200, toolCalling: true })
})
test('tests the draft using resolved credentials without saving or requiring exact probe contents', async () => {
  await expect(
    testProviderConnection({ ...provider, api_key_ref: 'saved-ref', api_key_configured: true })
  ).resolves.toEqual([{ model: 'upstream-a' }])
  expect(invoke).toHaveBeenCalledExactlyOnceWith('modelConfiguration.test', { provider })
  expect(probe).not.toHaveBeenCalled()
})
test('uses model overrides and reports each failed model without discarding successful results', async () => {
  invoke.mockResolvedValueOnce([
    { model: 'upstream-a', error: 'connection_test_failed' },
    { model: 'upstream-b' },
  ])
  const draft = {
    ...provider,
    models: [
      ...provider.models,
      {
        id: 'second',
        model_id: 'upstream-b',
        api_format: 'anthropic-messages' as const,
        request_path: '/messages',
      },
    ],
  }
  await expect(testProviderConnection(draft)).resolves.toEqual([
    { model: 'upstream-a', error: 'connection_test_failed' },
    { model: 'upstream-b' },
  ])
  expect(probe).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledWith('modelConfiguration.test', { provider: draft })
})
test('missing saved credentials cannot become an anonymous successful probe', async () => {
  invoke.mockResolvedValue([])
  await expect(testProviderConnection(provider)).rejects.toThrow('saved API Key is unavailable')
  expect(probe).not.toHaveBeenCalled()
})
