import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ModelConfigurationStore } from './model-configuration-store.js'
import { SecureValueStore } from './secure-value-store.js'
import { createTestSecretProtection } from '../../test/secret-protection.js'
import { ModelRuntimeRequest } from './model-runtime-request.js'
import type { ModelProvider } from './model-configuration-contract.js'

let directory: string
let store: ModelConfigurationStore
const provider: ModelProvider = {
  id: 'saved',
  name: 'Saved API',
  base_url: 'https://saved.example/v1',
  api_format: 'anthropic-messages',
  api_key: 'native-primary-secret',
  models: [{ id: 'assistant', model_id: 'saved-model' }],
}
const reference = {
  wework_model_kind: 'model-interface',
  wework_local_model_id: 'local-model:assistant',
  model_provider: 'local-assistant',
  base_url: 'https://untrusted.example',
  responses_url: 'https://untrusted.example/collect',
  api_key: 'dummy',
}
const local = { request: vi.fn(), dispose: vi.fn() }
const remote = vi.fn()
const proxy = vi.fn().mockResolvedValue(null)
let runtime: ModelRuntimeRequest

async function save(providers: ModelProvider[]) {
  await store.save((await store.read()).revision, providers)
}

beforeEach(async () => {
  vi.clearAllMocks()
  local.request.mockResolvedValue({ taskId: 'created' })
  proxy.mockResolvedValue(null)
  directory = await mkdtemp(join(tmpdir(), 'wework-native-model-request-'))
  store = new ModelConfigurationStore(
    join(directory, 'models'),
    new SecureValueStore(directory, createTestSecretProtection())
  )
  await save([provider])
  runtime = new ModelRuntimeRequest(store, local, remote, proxy)
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

test.each(['runtime.text.generate', 'runtime.text.predict_reply', 'runtime.tasks.create'])(
  'resolves saved credentials and endpoint for %s without accepting renderer overrides',
  async method => {
    const input = { modelConfig: { ...reference, reasoning: { effort: 'high' } } }
    await expect(runtime.request({ method, params: input })).resolves.toEqual({ taskId: 'created' })
    expect(local.request).toHaveBeenCalledWith(
      method,
      {
        modelConfig: expect.objectContaining({
          api_key: provider.api_key,
          responses_url: 'https://saved.example/v1/messages',
          upstream_api_format: 'anthropic-messages',
          reasoning: { effort: 'high' },
        }),
      },
      undefined
    )
    expect(proxy).toHaveBeenCalledWith('https://saved.example/v1/messages')
    expect(input.modelConfig.api_key).toBe('dummy')
    expect(remote).not.toHaveBeenCalled()
  }
)

test('uses rotated native credentials for the same public identity and refuses removed models', async () => {
  await runtime.request({ method: 'runtime.text.generate', params: { modelConfig: reference } })
  await save([{ ...provider, api_key: 'rotated-native-secret' }])
  await runtime.request({ method: 'runtime.text.generate', params: { modelConfig: reference } })
  expect(local.request.mock.calls[1][1].modelConfig.api_key).toBe('rotated-native-secret')
  await save([])
  await expect(
    runtime.request({ method: 'runtime.text.generate', params: { modelConfig: reference } })
  ).rejects.toThrow('select it again')
  expect(local.request).toHaveBeenCalledTimes(2)
})

test('rejects disabled models and forged provider identities without executing', async () => {
  await expect(
    runtime.request({
      method: 'runtime.tasks.create',
      params: { modelConfig: { ...reference, model_provider: 'another-provider' } },
    })
  ).rejects.toThrow('unavailable')
  await save([{ ...provider, enabled: false }])
  await expect(
    runtime.request({ method: 'runtime.tasks.create', params: { modelConfig: reference } })
  ).rejects.toThrow('unavailable')
  expect(local.request).not.toHaveBeenCalled()
})

test('resolves standalone harness upstreams through the same private projection', async () => {
  await runtime.request({
    method: 'runtime.harness_proxy.register',
    params: { upstream: reference },
  })
  expect(local.request.mock.calls[0][1].upstream).toMatchObject({
    api_key: provider.api_key,
    request_url: 'https://saved.example/v1/messages',
    api_format: 'anthropic-messages',
    model_id: 'saved-model',
  })
})

test.each(['runtime.collaboration.dispatch', 'executions.enqueue', 'runtime.automations.create'])(
  'resolves nested manager and member requests in %s',
  async method => {
    await runtime.request({
      method,
      params: {
        managerRuntimeRequest: { model_config: reference },
        memberRuntimeProfiles: [{ runtimePayload: { modelConfig: reference } }],
      },
    })
    const payload = local.request.mock.calls[0][1]
    expect(payload.managerRuntimeRequest.model_config.api_key).toBe(provider.api_key)
    expect(payload.memberRuntimeProfiles[0].runtimePayload.modelConfig.api_key).toBe(
      provider.api_key
    )
  }
)

test('uses each private vision endpoint and preserves separate native proxy selection', async () => {
  await save([
    { ...provider, models: [{ ...provider.models[0], vision_model_config_id: 'vision' }] },
    {
      ...provider,
      id: 'vision-provider',
      base_url: 'https://vision.example/v1',
      api_format: 'openai-chat-completions',
      api_key: 'native-vision-secret',
      models: [{ id: 'vision', model_id: 'vision-model' }],
    },
  ])
  proxy.mockImplementation(async url =>
    url.includes('vision') ? 'http://vision-proxy:8080' : null
  )
  local.request.mockImplementation(async (_method, params) => params)
  const result = await runtime.request({
    method: 'runtime.text.generate',
    params: { modelConfig: reference },
  })
  expect(local.request.mock.calls[0][1].modelConfig.vision_sidecar).toMatchObject({
    request_url: 'https://vision.example/v1/chat/completions',
    api_key: 'native-vision-secret',
    proxy: { url: 'http://vision-proxy:8080' },
  })
  expect(JSON.stringify(result)).not.toContain('native-primary-secret')
  expect(JSON.stringify(result)).not.toContain('native-vision-secret')
  expect(result).toMatchObject({ modelConfig: { api_key: '[redacted]' } })
})

test('redacts a runtime error that echoes private credentials', async () => {
  local.request.mockRejectedValue(new Error('Remote rejected native-primary-secret'))
  await expect(
    runtime.request({ method: 'runtime.text.predict_reply', params: { modelConfig: reference } })
  ).rejects.toThrow('Remote rejected [redacted]')
})

test('preserves response identities and text when saved credentials overlap with public data', async () => {
  await save([
    { ...provider, api_key: 'a' },
    {
      ...provider,
      id: 'unused',
      api_key: 'task',
      models: [{ ...provider.models[0], id: 'unused-assistant' }],
    },
  ])
  const response = {
    taskId: 'task-a12',
    executionId: 'execution-data',
    text: 'A task can retain its data',
    profiles: [{ modelConfig: { ...reference, api_key: 'a' } }],
  }
  local.request.mockResolvedValue(response)

  await expect(
    runtime.request({ method: 'runtime.tasks.create', params: { modelConfig: reference } })
  ).resolves.toEqual({
    ...response,
    profiles: [{ modelConfig: { ...reference, api_key: '[redacted]' } }],
  })
  expect(response.profiles[0].modelConfig.api_key).toBe('a')
})

test('does not use credentials from unrelated providers to alter runtime errors', async () => {
  await save([
    provider,
    {
      ...provider,
      id: 'unused',
      api_key: 'task',
      models: [{ ...provider.models[0], id: 'unused-assistant' }],
    },
  ])
  local.request.mockRejectedValue(
    Object.assign(new Error('The task failed native-primary-secret'), { code: 'task_failed' })
  )

  await expect(
    runtime.request({ method: 'runtime.tasks.create', params: { modelConfig: reference } })
  ).rejects.toMatchObject({ message: 'The task failed [redacted]', code: 'task_failed' })
})

test('preserves error codes and sanitized diagnostics throughout a runtime cause chain', async () => {
  const error = Object.assign(
    new Error('Request failed native-primary-secret', {
      cause: new TypeError('Connection rejected native-primary-secret'),
    }),
    { code: 'runtime_unavailable', details: { remote: 'native-primary-secret' } }
  )
  local.request.mockRejectedValue(error)
  const result = await runtime
    .request({ method: 'runtime.text.generate', params: { modelConfig: reference } })
    .catch(error => error)
  expect(result).toMatchObject({
    code: 'runtime_unavailable',
    details: { remote: '[redacted]' },
    cause: { name: 'TypeError', message: 'Connection rejected [redacted]' },
  })
  expect(result.stack).not.toContain(provider.api_key)
  expect(result.cause.stack).not.toContain(provider.api_key)
  expect(error.message).toContain(provider.api_key)
})

test('validates the cloud destination before opening any model credential', async () => {
  const read = vi.spyOn(store, 'runtime')
  remote.mockRejectedValue(new Error('Cloud runtime target is not configured'))
  await expect(
    runtime.request({
      method: 'runtime.tasks.create',
      params: { modelConfig: reference },
      target: {},
    })
  ).rejects.toThrow('not configured')
  expect(read).not.toHaveBeenCalled()
  expect(local.request).not.toHaveBeenCalled()
})

test('sends resolved models through the existing authenticated cloud transport', async () => {
  const cloud = { request: vi.fn().mockResolvedValue({ accepted: true }), dispose: vi.fn() }
  remote.mockResolvedValue(cloud)
  const input = {
    method: 'runtime.tasks.create',
    params: { modelConfig: reference },
    target: { apiBaseUrl: 'https://configured.example/api' },
    expectedUserId: 7,
    deviceId: 'selected-device',
  }
  await expect(runtime.request(input)).resolves.toEqual({ accepted: true })
  expect(remote).toHaveBeenCalledWith(input)
  expect(cloud.request).toHaveBeenCalledWith(
    input.method,
    { modelConfig: expect.objectContaining({ api_key: provider.api_key }) },
    'selected-device'
  )
  expect(local.request).not.toHaveBeenCalled()
  expect(proxy).not.toHaveBeenCalled()
})

test('rejects unrelated operations before reading private model configuration', async () => {
  const read = vi.spyOn(store, 'runtime')
  await expect(
    runtime.request({ method: 'files.write', params: { modelConfig: reference } })
  ).rejects.toThrow('Unsupported')
  await expect(runtime.request({ method: 'runtime.text.generate', params: {} })).rejects.toThrow(
    'reference is required'
  )
  expect(read).not.toHaveBeenCalled()
  expect(local.request).not.toHaveBeenCalled()
})
