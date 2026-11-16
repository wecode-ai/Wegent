// @vitest-environment node

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

it('binds a private conversation to a stand-in on its selected device', async () => {
  const binding = { deviceId: 'mac', roleId: 'reviewer' }
  const put = vi.fn().mockResolvedValue(binding)
  const api = createImSessionApi({ put } as unknown as HttpClient)
  await expect(api.bindStandIn('session/key', binding)).resolves.toEqual(binding)
  expect(put).toHaveBeenCalledWith('/im/private-sessions/session%2Fkey/stand-in', binding)
})
