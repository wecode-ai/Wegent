import { describe, expect, test, vi } from 'vitest'
import { createTaskApi } from './tasks'
import type { HttpClient } from './http'

describe('createTaskApi', () => {
  test('renameTask sends the Wework client origin', async () => {
    const client = {
      put: vi.fn().mockResolvedValue({
        id: 42,
        title: 'Renamed',
        status: 'PENDING',
      }),
    } as unknown as HttpClient

    const api = createTaskApi(client)

    await api.renameTask(42, 'Renamed')

    expect(client.put).toHaveBeenCalledWith('/tasks/42?client_origin=wework', {
      title: 'Renamed',
    })
  })
})
