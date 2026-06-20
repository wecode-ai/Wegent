import { describe, expect, test, vi } from 'vitest'
import { createLocalCodexApi } from './localCodex'
import type { HttpClient } from './http'

describe('createLocalCodexApi', () => {
  test('lists local Codex threads with the default limit', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({
        threads: [
          {
            threadId: 'thread-1',
            title: 'Thread one',
          },
        ],
      }),
    } as unknown as HttpClient

    const api = createLocalCodexApi(client)

    await expect(api.listLocalCodexThreads('device/1')).resolves.toEqual([
      {
        threadId: 'thread-1',
        title: 'Thread one',
      },
    ])

    expect(client.get).toHaveBeenCalledWith('/local-codex/devices/device%2F1/threads?limit=50')
  })

  test('posts local Codex bind requests', async () => {
    const response = {
      taskId: 8,
      task: {
        id: 8,
        title: 'Bound thread',
        status: 'COMPLETED',
        created_at: '2026-06-20T00:00:00Z',
      },
      created: true,
    }
    const client = {
      post: vi.fn().mockResolvedValue(response),
    } as unknown as HttpClient

    const api = createLocalCodexApi(client)
    const request = {
      deviceId: 'device/1',
      threadId: 'thread-1',
      teamId: 12,
      title: 'Bound thread',
      cwd: '/workspace/project',
    }

    await expect(api.bindLocalCodexThread(request)).resolves.toBe(response)

    expect(client.post).toHaveBeenCalledWith('/local-codex/threads/bind', request)
  })

  test('surfaces API errors from the HTTP client', async () => {
    const error = new Error('network failed')
    const client = {
      get: vi.fn().mockRejectedValue(error),
    } as unknown as HttpClient

    const api = createLocalCodexApi(client)

    await expect(api.listLocalCodexThreads('device-1')).rejects.toThrow('network failed')
  })
})
