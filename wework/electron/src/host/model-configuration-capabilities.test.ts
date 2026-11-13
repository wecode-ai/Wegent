import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HostCapabilityRouter } from './capability-router.js'
import { DesktopHostEventBroker } from './desktop-host-events.js'
import { registerModelConfigurationCapabilities } from './model-configuration-capabilities.js'
import { ModelConfigurationStore } from './model-configuration-store.js'
import { SecureValueStore } from './secure-value-store.js'
import { createTestSecretProtection } from '../../test/secret-protection.js'
import type { ModelProvider } from './model-configuration-contract.js'

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }))
let directory: string
let store: ModelConfigurationStore
let router: HostCapabilityRouter
const principal = '@wegent/dsh-app-wework'
const provider: ModelProvider = {
  id: 'test',
  name: 'Test provider',
  base_url: 'https://model.example/v1',
  api_format: 'anthropic-messages',
  api_key: 'native-only-secret',
  models: [{ id: 'assistant', model_id: 'upstream', display_name: 'Assistant' }],
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wework-native-models-'))
  const secrets = new SecureValueStore(directory, createTestSecretProtection())
  store = new ModelConfigurationStore(join(directory, 'models'), secrets)
  const snapshot = await store.read()
  await store.save(snapshot.revision, [provider])
  router = new HostCapabilityRouter()
  registerModelConfigurationCapabilities(
    router,
    () => null,
    secrets,
    new DesktopHostEventBroker(),
    store
  )
  router.grant(principal, ['modelConfiguration.runtime', 'modelConfiguration.test'])
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

test('returns runtime metadata without decrypting keys into an HTTP response or accepting draft overrides', async () => {
  const result = await router.invoke(principal, 'modelConfiguration.runtime', {
    provider: { ...provider, base_url: 'https://attacker.example' },
  })
  expect(result).toMatchObject({
    models: [{ provider: { base_url: provider.base_url, api_key_configured: true } }],
  })
  expect(JSON.stringify(result)).not.toContain('native-only-secret')
  expect(JSON.stringify(result)).not.toContain('api_key_ref')
  // The private executor path still receives the credential.
  expect((await store.runtime()).models[0].provider.api_key).toBe('native-only-secret')
})

test('probes through the native host and never exposes remote errors containing credentials', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('native-only-secret', { status: 401 }))
  vi.stubGlobal('fetch', fetcher)
  const draft = { ...provider, api_key: undefined }
  const result = await router.invoke(principal, 'modelConfiguration.test', { provider: draft })
  expect(result).toEqual([{ model: 'Assistant', error: 'connection_test_failed' }])
  expect(fetcher).toHaveBeenCalledWith(
    'https://model.example/v1/messages',
    expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({ 'x-api-key': 'native-only-secret' }),
    })
  )
  expect(JSON.stringify(result)).not.toContain('native-only-secret')
})

test('refuses to forward a saved credential to a draft connection address', async () => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  await expect(
    router.invoke(principal, 'modelConfiguration.test', {
      provider: { ...provider, api_key: undefined, base_url: 'https://attacker.example' },
    })
  ).rejects.toThrow(/API key again/)
  expect(fetcher).not.toHaveBeenCalled()
})

test('uses each model protocol override and isolates a failed model probe', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const { model } = JSON.parse(String(init?.body))
    if (model === 'upstream') return new Response('native-only-secret', { status: 401 })
    if (model === 'completion')
      return Response.json({
        choices: [{ message: { tool_calls: [{ function: { name: 'wework_capability_probe' } }] } }],
      })
    if (model === 'responses')
      return Response.json({
        output: [
          {
            type: 'function_call',
            name: 'wework_capability_probe',
            arguments: '{"input":"PING"}',
          },
        ],
      })
    return Response.json({
      output: [{ type: 'custom_tool_call', name: 'apply_patch', input: 'probe patch' }],
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const draft: ModelProvider = {
    ...provider,
    api_key: undefined,
    request_path: '/messages',
    models: [
      provider.models[0],
      {
        id: 'completion',
        model_id: 'completion',
        api_format: 'openai-chat-completions',
        request_path: '/custom-completions',
      },
      { id: 'responses', model_id: 'responses', api_format: 'openai-responses' },
      {
        id: 'custom',
        model_id: 'custom',
        api_format: 'openai-responses',
        tool_profile: 'custom',
      },
    ],
  }
  expect(await router.invoke(principal, 'modelConfiguration.test', { provider: draft })).toEqual([
    { model: 'Assistant', error: 'connection_test_failed' },
    { model: 'completion' },
    { model: 'responses' },
    { model: 'custom' },
  ])
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://model.example/v1/messages',
    'https://model.example/v1/custom-completions',
    'https://model.example/v1/responses',
    'https://model.example/v1/responses',
  ])
  expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).tools).toMatchObject([
    { type: 'function', name: 'wework_capability_probe' },
  ])
  expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body)).tools).toMatchObject([
    { type: 'custom', name: 'apply_patch' },
  ])
})

test.each(['not-json', '{}', '{"input":" "}'])(
  'rejects malformed Responses function arguments through the native capability: %s',
  async argumentsValue => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        output: [
          { type: 'function_call', name: 'wework_capability_probe', arguments: argumentsValue },
        ],
      })
    )
    vi.stubGlobal('fetch', fetcher)
    const result = await router.invoke(principal, 'modelConfiguration.test', {
      provider: {
        ...provider,
        api_key: undefined,
        models: [{ ...provider.models[0], api_format: 'openai-responses' }],
      },
    })
    expect(result).toEqual([{ model: 'Assistant', error: 'connection_test_failed' }])
    expect(fetcher).toHaveBeenCalledWith(
      'https://model.example/v1/responses',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer native-only-secret' }),
      })
    )
    expect(JSON.stringify(result)).not.toContain('native-only-secret')
  }
)

test('preserves the MiniMax probe protocol without returning its credential', async () => {
  const draft: ModelProvider = {
    ...provider,
    base_url: 'https://api.minimaxi.com/anthropic',
    models: [{ ...provider.models[0], provider_profile_id: 'minimax' }],
  }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      choices: [{ message: { tool_calls: [{ function: { name: 'wework_capability_probe' } }] } }],
    })
  )
  vi.stubGlobal('fetch', fetcher)
  expect(await router.invoke(principal, 'modelConfiguration.test', { provider: draft })).toEqual([
    { model: 'Assistant' },
  ])
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.minimaxi.com/v1/text/chatcompletion_v2',
    expect.objectContaining({ method: 'POST' })
  )
})
