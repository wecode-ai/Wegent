import { beforeEach, expect, it, vi } from 'vitest'
import { McpAppRuntime } from './mcp-app-runtime.js'
import { createCloudRuntimeIpcClient } from '../vendor/chat-core/runtime-ipc.js'

vi.mock('../vendor/chat-core/runtime-ipc.js', () => ({ createCloudRuntimeIpcClient: vi.fn() }))
const cloud = { request: vi.fn().mockResolvedValue({}), dispose: vi.fn() }
const target = {
  apiBaseUrl: 'https://cloud.example/api',
  socketBaseUrl: 'https://cloud.example',
  socketPath: '/socket.io',
}
const payload = {
  address: { deviceId: 'remote', taskId: 'task' },
  callId: 'call',
  method: 'release',
  sessionId: 'app',
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createCloudRuntimeIpcClient).mockReturnValue(cloud as never)
})

it('routes native cleanup to the correct executor and reuses refreshed authentication', async () => {
  const local = vi.fn().mockResolvedValue({ local: true })
  const token = vi.fn().mockResolvedValueOnce('first').mockResolvedValue('second')
  const runtime = new McpAppRuntime(local, token, async () => target)
  expect(await runtime.request(payload)).toEqual({ local: true })
  await runtime.request({ ...payload, method: 'retain', target })
  await runtime.request({ ...payload, method: 'retain', target })
  expect(local).toHaveBeenCalledTimes(1)
  expect(createCloudRuntimeIpcClient).toHaveBeenCalledTimes(1)
  expect(cloud.request).toHaveBeenLastCalledWith(
    'runtime.mcp_apps.request',
    { ...payload, method: 'retain' },
    'remote'
  )
  expect(vi.mocked(createCloudRuntimeIpcClient).mock.calls[0][0].getToken()).toBe('second')
  runtime.dispose()
  expect(cloud.dispose).toHaveBeenCalledOnce()
})

it('rejects a different credential destination before obtaining a token', async () => {
  const token = vi.fn()
  const runtime = new McpAppRuntime(vi.fn(), token, async () => target)
  await expect(
    runtime.request({ ...payload, target: { ...target, socketBaseUrl: 'https://other.example' } })
  ).rejects.toThrow('not configured')
  expect(token).not.toHaveBeenCalled()
  expect(createCloudRuntimeIpcClient).not.toHaveBeenCalled()
})

it('preserves a configured socket override and existing access-token mode', async () => {
  const configured = { ...target, socketBaseUrl: 'wss://socket.example' }
  const refresh = vi.fn()
  const runtime = new McpAppRuntime(vi.fn(), refresh, async () => ({
    ...configured,
    credentialMode: 'legacy_access_token',
    token: 'legacy',
  }))
  await runtime.request({ ...payload, target: configured })
  expect(refresh).not.toHaveBeenCalled()
  expect(vi.mocked(createCloudRuntimeIpcClient).mock.calls[0][0].getToken()).toBe('legacy')
  runtime.dispose()
})

it('disposes through its acquired client after the user disconnects cloud settings', async () => {
  const connection = vi.fn().mockResolvedValueOnce(target).mockResolvedValue(null)
  const runtime = new McpAppRuntime(vi.fn(), vi.fn().mockResolvedValue('token'), connection)
  await runtime.request({ ...payload, method: 'retain', target })
  await runtime.request({ ...payload, target })
  expect(connection).toHaveBeenCalledTimes(1)
  expect(cloud.request).toHaveBeenLastCalledWith('runtime.mcp_apps.request', payload, 'remote')
  runtime.dispose()
})
