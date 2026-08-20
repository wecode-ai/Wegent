import { describe, expect, test, vi } from 'vitest'
import type { HttpClient } from './http'
import { createExternalEventApi } from './externalEvents'

describe('createExternalEventApi', () => {
  test('loads the provider event catalog', async () => {
    const client = {
      get: vi.fn().mockResolvedValue([{ provider: 'gitlab' }]),
    } as unknown as HttpClient
    const api = createExternalEventApi(client)

    await api.catalog()

    expect(client.get).toHaveBeenCalledWith('/v1/external-events/catalog')
  })
})
