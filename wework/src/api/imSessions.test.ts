import { describe, expect, test, vi } from 'vitest'
import { createImSessionApi } from './imSessions'
import type { HttpClient } from './http'

describe('createImSessionApi', () => {
  test('lists private IM sessions', async () => {
    const get = vi.fn().mockResolvedValue({ total: 0, items: [] })
    const api = createImSessionApi({ get } as unknown as HttpClient)

    await expect(api.listPrivateSessions()).resolves.toEqual({ total: 0, items: [] })

    expect(get).toHaveBeenCalledWith('/im/private-sessions')
  })
})
