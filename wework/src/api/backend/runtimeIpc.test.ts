import { describe, expect, it, vi } from 'vitest'
import { createCloudRuntimeIpcClient as createSharedCloudRuntimeIpcClient } from '@wegent/chat-core'
import { createCloudRuntimeIpcClient, RUNTIME_TRANSCRIPT_ACK_TIMEOUT_MS } from './runtimeIpc'

vi.mock('@wegent/chat-core', () => ({
  createCloudRuntimeIpcClient: vi.fn(() => ({ request: vi.fn(), dispose: vi.fn() })),
  RUNTIME_TRANSCRIPT_ACK_TIMEOUT_MS: 15_000,
}))

describe('desktop runtime IPC adapter', () => {
  it('uses the shared client with the desktop socket configuration and token', () => {
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      token: 'desktop-token',
    })
    const shared = vi.mocked(createSharedCloudRuntimeIpcClient)
    const options = shared.mock.calls[0][0]
    expect(options.socketBaseUrl).toBe('https://cloud.example.com')
    expect(options.socketPath).toBe('/socket.io')
    expect(options.getToken()).toBe('desktop-token')
    expect(client).toBe(shared.mock.results[0].value)
    expect(RUNTIME_TRANSCRIPT_ACK_TIMEOUT_MS).toBe(15_000)
  })
})
