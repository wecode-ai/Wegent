import { describe, expect, test, vi } from 'vitest'
import { createTaskApi } from './tasks'
import type { HttpClient } from './http'

describe('createTaskApi', () => {
  test('forkTask posts target payload with client origin', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({
        task_id: 86,
        task: { id: 86, title: 'Forked', status: 'PENDING' },
      }),
    } as unknown as HttpClient

    const api = createTaskApi(client)

    await api.forkTask(42, {
      target: {
        type: 'device',
        device_id: 'macbook-pro',
      },
    })

    expect(client.post).toHaveBeenCalledWith('/tasks/42/fork?client_origin=wework', {
      target: {
        type: 'device',
        device_id: 'macbook-pro',
      },
    })
  })
})
