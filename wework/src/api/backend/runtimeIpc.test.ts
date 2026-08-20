import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudRuntimeIpcClient } from './runtimeIpc'

const socket = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}
const ensureConnected = vi.fn().mockResolvedValue(undefined)
const dispose = vi.fn()

vi.mock('@wegent/chat-core', () => ({
  createSocketClient: () => ({
    socket,
    ensureConnected,
    dispose,
  }),
}))

describe('createCloudRuntimeIpcClient', () => {
  beforeEach(() => {
    socket.emit.mockReset()
    socket.on.mockReset()
    socket.off.mockReset()
    ensureConnected.mockClear()
    dispose.mockClear()
  })

  it('decompresses large runtime results returned through the socket acknowledgement', async () => {
    const expected = {
      success: true,
      messages: [{ id: 'message-1', content: '历史消息🙂'.repeat(1000) }],
    }
    const raw = Buffer.from(JSON.stringify(expected))
    const compressed = gzipSync(raw)
    socket.emit.mockImplementation((_event, _request, acknowledge) => {
      acknowledge({
        ok: true,
        result: {
          __runtimeRpcEncoding: 'gzip+base64+json',
          payload: compressed.toString('base64'),
          rawBytes: raw.length,
          compressedBytes: compressed.length,
        },
      })
    })
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      token: 'token',
    })

    await expect(client.request('runtime.tasks.transcript', {}, 'cloud-device')).resolves.toEqual(
      expected
    )
  })

  it('preserves ordinary runtime results', async () => {
    socket.emit.mockImplementation((_event, _request, acknowledge) => {
      acknowledge({ ok: true, result: { success: true } })
    })
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      token: 'token',
    })

    await expect(client.request('runtime.tasks.list', {}, 'cloud-device')).resolves.toEqual({
      success: true,
    })
  })

  it('uses the requested device command timeout for the relay and acknowledgement', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload).toMatchObject({
        method: 'device.execute_command',
        device_id: 'device-1',
        timeout_seconds: 300,
      })
      ack({ ok: true, result: { success: true } })
    })
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      token: 'token',
    })

    await expect(
      client.request(
        'device.execute_command',
        { command_key: 'git_clone', timeout_seconds: 300 },
        'device-1'
      )
    ).resolves.toEqual({ success: true })

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 310_000)
    timeoutSpy.mockRestore()
  })

  it('keeps the default timeout for ordinary runtime requests', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload).toMatchObject({
        method: 'runtime.tasks.list',
        device_id: 'device-1',
        timeout_seconds: 75,
      })
      ack({ ok: true, result: [] })
    })
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      token: 'token',
    })

    await expect(client.request('runtime.tasks.list', {}, 'device-1')).resolves.toEqual([])

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 75_000)
    timeoutSpy.mockRestore()
  })

  it('caps device command timeouts at the executor maximum', async () => {
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload.timeout_seconds).toBe(600)
      ack({ ok: true, result: { success: true } })
    })
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      token: 'token',
    })

    await expect(
      client.request('device.execute_command', { timeout_seconds: 900 }, 'device-1')
    ).resolves.toEqual({ success: true })
  })
})
