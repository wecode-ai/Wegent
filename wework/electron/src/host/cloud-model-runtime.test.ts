import { beforeEach, expect, test, vi } from 'vitest'
import { CloudModelRuntime } from './cloud-model-runtime.js'
import { createCloudRuntimeIpcClient } from '../vendor/chat-core/runtime-ipc.js'

vi.mock('../vendor/chat-core/runtime-ipc.js', () => ({ createCloudRuntimeIpcClient: vi.fn() }))
const target = {
  apiBaseUrl: 'https://cloud.example/api',
  socketBaseUrl: 'wss://configured-socket.example',
  socketPath: '/custom/socket.io',
}
const input = { target, expectedUserId: 7, deviceId: 'chosen-device' }
const cloud = { request: vi.fn().mockResolvedValue({ accepted: true }), dispose: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createCloudRuntimeIpcClient).mockReturnValue(cloud as never)
})

test('reuses the current native socket until the product token rotates', async () => {
  const refresh = vi
    .fn()
    .mockResolvedValueOnce('first')
    .mockResolvedValueOnce('first')
    .mockResolvedValue('rotated')
  const rotated = { request: vi.fn().mockResolvedValue({ accepted: true }), dispose: vi.fn() }
  const createClient = vi.mocked(createCloudRuntimeIpcClient)
  createClient.mockReturnValueOnce(cloud as never).mockReturnValueOnce(rotated as never)
  const runtime = new CloudModelRuntime(async () => ({ ...target, user: { id: 7 } }), refresh)
  const transport = await runtime.transport(input)
  await transport.request('runtime.tasks.create', { modelConfig: {} }, 'chosen-device')
  await runtime.transport(input)
  expect(createClient).toHaveBeenCalledOnce()
  expect(cloud.dispose).not.toHaveBeenCalled()
  const current = await runtime.transport(input)
  await current.request('runtime.tasks.send', {}, 'chosen-device')
  expect(createClient).toHaveBeenCalledTimes(2)
  const options = createClient.mock.calls[1][0]
  expect(options).toMatchObject({
    socketBaseUrl: target.socketBaseUrl,
    socketPath: target.socketPath,
  })
  expect(createClient.mock.calls[0][0].getToken()).toBe('first')
  expect(options.getToken()).toBe('rotated')
  expect(refresh).toHaveBeenCalledWith(target.apiBaseUrl, 7)
  expect(cloud.request).toHaveBeenCalledWith(
    'runtime.tasks.create',
    { modelConfig: {} },
    'chosen-device',
    undefined
  )
  expect(rotated.request).toHaveBeenCalledWith('runtime.tasks.send', {}, 'chosen-device', undefined)
  expect(cloud.dispose).toHaveBeenCalledOnce()
  runtime.dispose()
  expect(cloud.dispose).toHaveBeenCalledOnce()
  expect(rotated.dispose).toHaveBeenCalledOnce()
})

test('drains in-flight calls while new requests use the rotated socket', async () => {
  const started = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<{ accepted: boolean }>()
  const original = {
    request: vi.fn(() => {
      started.resolve()
      return reply.promise
    }),
    dispose: vi.fn(),
  }
  vi.mocked(createCloudRuntimeIpcClient).mockReturnValueOnce(original as never)
  const refresh = vi.fn().mockResolvedValueOnce('first').mockResolvedValue('rotated')
  const runtime = new CloudModelRuntime(async () => ({ ...target, user: { id: 7 } }), refresh)
  const transport = await runtime.transport(input)
  const pending = transport.request('runtime.tasks.create', {}, input.deviceId)
  await started.promise

  await runtime.transport(input)
  await transport.request('runtime.tasks.send', {}, input.deviceId)
  expect(cloud.request).toHaveBeenCalledWith('runtime.tasks.send', {}, input.deviceId, undefined)
  expect(original.dispose).not.toHaveBeenCalled()

  reply.resolve({ accepted: true })
  await expect(pending).resolves.toEqual({ accepted: true })
  expect(original.dispose).toHaveBeenCalledOnce()
  runtime.dispose()
  expect(original.dispose).toHaveBeenCalledOnce()
  expect(cloud.dispose).toHaveBeenCalledOnce()
})

test.each([
  { ...input, target: { ...target, socketBaseUrl: 'https://untrusted.example' } },
  { ...input, expectedUserId: 8 },
  { ...input, deviceId: '' },
])('rejects changed authority before authenticating: %j', async request => {
  const refresh = vi.fn()
  const runtime = new CloudModelRuntime(async () => ({ ...target, user: { id: 7 } }), refresh)
  await expect(runtime.transport(request)).rejects.toThrow()
  expect(refresh).not.toHaveBeenCalled()
  expect(createCloudRuntimeIpcClient).not.toHaveBeenCalled()
})

test('replaces the prior native socket when the saved account changes', async () => {
  let id = 7
  const runtime = new CloudModelRuntime(
    async () => ({
      ...target,
      user: { id },
      credentialMode: 'legacy_access_token',
      token: 'legacy',
    }),
    vi.fn()
  )
  await runtime.transport(input)
  id = 8
  await expect(runtime.transport(input)).rejects.toThrow('account changed')
  await runtime.transport({ ...input, expectedUserId: 8 })
  expect(cloud.dispose).toHaveBeenCalledOnce()
  expect(createCloudRuntimeIpcClient).toHaveBeenCalledTimes(2)
  runtime.dispose()
})

test('does not dispatch an acquired request after its saved account changes or it is disposed', async () => {
  let id = 7
  const runtime = new CloudModelRuntime(
    async () => ({ ...target, user: { id } }),
    async () => 'token'
  )
  const transport = await runtime.transport(input)
  id = 8
  await expect(transport.request('runtime.tasks.create', {}, input.deviceId)).rejects.toThrow(
    'account changed'
  )
  id = 7
  runtime.dispose()
  await expect(transport.request('runtime.tasks.create', {}, input.deviceId)).rejects.toThrow(
    'account changed'
  )
  expect(cloud.request).not.toHaveBeenCalled()
})
