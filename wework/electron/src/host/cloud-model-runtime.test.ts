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
  expect(createClient.mock.calls[0][0].getToken()).toBe('first')
  const current = await runtime.transport(input)
  await current.request('runtime.tasks.send', {}, 'chosen-device')
  expect(createClient).toHaveBeenCalledTimes(2)
  const options = createClient.mock.calls[1][0]
  expect(options).toMatchObject({
    socketBaseUrl: target.socketBaseUrl,
    socketPath: target.socketPath,
  })
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

test('authenticates a draining request on reconnect with the rotated token', async () => {
  const started = Promise.withResolvers<void>()
  const reconnect = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<{ accepted: boolean }>()
  const createClient = vi.mocked(createCloudRuntimeIpcClient)
  const original = {
    request: vi.fn(async () => {
      started.resolve()
      await reconnect.promise
      if (createClient.mock.calls[0][0].getToken() !== 'rotated') {
        throw new Error('Socket authentication expired')
      }
      return reply.promise
    }),
    dispose: vi.fn(),
  }
  createClient.mockReturnValueOnce(original as never)
  const refresh = vi.fn().mockResolvedValueOnce('first').mockResolvedValue('rotated')
  const runtime = new CloudModelRuntime(async () => ({ ...target, user: { id: 7 } }), refresh)
  const transport = await runtime.transport(input)
  const pending = transport.request('runtime.tasks.create', {}, input.deviceId)
  await started.promise

  await runtime.transport(input)
  await transport.request('runtime.tasks.send', {}, input.deviceId)
  expect(cloud.request).toHaveBeenCalledWith('runtime.tasks.send', {}, input.deviceId, undefined)
  expect(original.dispose).not.toHaveBeenCalled()

  reconnect.resolve()
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

test.each([
  { target, account: 8, error: 'account changed' },
  {
    target: { ...target, socketPath: '/other/socket.io' },
    account: 7,
    error: 'target is not configured',
  },
])('revokes prior socket authentication when the saved scope changes: $error', async changed => {
  const createClient = vi.mocked(createCloudRuntimeIpcClient)
  let profile = { ...target, user: { id: 7 }, token: 'initial' }
  const runtime = new CloudModelRuntime(async () => profile, vi.fn())
  const transport = await runtime.transport(input)
  const prior = createClient.mock.calls[0][0]
  expect(prior.getToken()).toBe('initial')

  profile = { ...changed.target, user: { id: changed.account }, token: 'different' }
  await expect(runtime.transport(input)).rejects.toThrow(changed.error)
  await runtime.transport({ ...input, target: changed.target, expectedUserId: changed.account })
  expect(cloud.dispose).toHaveBeenCalledOnce()
  expect(createClient).toHaveBeenCalledTimes(2)
  expect(prior.getToken()).toBeNull()
  const current = createClient.mock.calls[1][0]
  expect(current.getToken()).toBe('different')
  await expect(transport.request('runtime.tasks.create', {}, input.deviceId)).rejects.toThrow()
  runtime.dispose()
  expect(current.getToken()).toBeNull()
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
