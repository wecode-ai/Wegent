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
  invoke.mockImplementation(async (_method, params) => ({
    models: params.provider.models.map((model: object) => ({
      provider: { ...params.provider, api_key: 'resolved-key' },
      model,
    })),
  }))
  probe.mockResolvedValue({ status: 200, toolCalling: true })
})
test('tests the draft using resolved credentials without saving or requiring exact probe contents', async () => {
  await expect(
    testProviderConnection({ ...provider, api_key_ref: 'saved-ref', api_key_configured: true })
  ).resolves.toEqual([{ model: 'upstream-a' }])
  expect(invoke).toHaveBeenCalledExactlyOnceWith('modelConfiguration.runtime', { provider })
  expect(probe).toHaveBeenCalledWith(
    expect.objectContaining({
      modelId: 'upstream-a',
      apiKey: 'resolved-key',
      baseUrl: provider.base_url,
    }),
    { verifyExactProbePayload: false, fetcher: expect.any(Function) }
  )
})
test('uses model overrides and reports each failed model without discarding successful results', async () => {
  probe.mockRejectedValueOnce(new Error('HTTP 401: bad key'))
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
    { model: 'upstream-a', error: 'HTTP 401: bad key' },
    { model: 'upstream-b' },
  ])
  expect(probe).toHaveBeenLastCalledWith(
    expect.objectContaining({ apiFormat: 'anthropic-messages', requestPath: '/messages' }),
    expect.any(Object)
  )
})
test('missing saved credentials cannot become an anonymous successful probe', async () => {
  invoke.mockResolvedValue({ models: [] })
  await expect(testProviderConnection(provider)).rejects.toThrow('saved API Key is unavailable')
  expect(probe).not.toHaveBeenCalled()
})

test('the probe fetcher forwards only a runtime reference and body over IPC', async () => {
  const browserFetch = vi.spyOn(globalThis, 'fetch')
  invoke.mockImplementation(async method =>
    method === 'modelConfiguration.runtime'
      ? {
          models: [
            {
              provider: { ...provider, api_key: 'wework-vault.synthetic-reference' },
              model: provider.models[0],
            },
          ],
        }
      : { status: 200, body: '{"ok":true}' }
  )
  probe.mockImplementation(async (_config, { fetcher }) => {
    const response = await fetcher('https://renderer-supplied.invalid', {
      headers: { Authorization: 'must-not-forward' },
      body: '{"model":"upstream-a"}',
    })
    expect(await response.json()).toEqual({ ok: true })
  })
  try {
    await testProviderConnection(provider)
    expect(invoke).toHaveBeenLastCalledWith('modelConfiguration.probe', {
      reference: 'wework-vault.synthetic-reference',
      preset: false,
      body: '{"model":"upstream-a"}',
    })
    expect(browserFetch).not.toHaveBeenCalled()
  } finally {
    browserFetch.mockRestore()
  }
})
