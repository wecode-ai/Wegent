import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudRuntimeIpcClient } from './runtimeIpc'

const socket = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}
const ensureConnected = vi.fn().mockResolvedValue(undefined)

vi.mock('@wegent/chat-core', () => ({
  createSocketClient: () => ({
    socket,
    ensureConnected,
    dispose: vi.fn(),
  }),
}))

describe('createCloudRuntimeIpcClient', () => {
  beforeEach(() => {
    socket.emit.mockReset()
    socket.on.mockReset()
    socket.off.mockReset()
    ensureConnected.mockClear()
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
})
