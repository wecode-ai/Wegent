// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { userApis, setToken, removeToken } from '@/apis/user'
import type { QuickAccessResponse } from '@/types/api'

jest.mock('@/apis/client', () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}))

const quickAccessResponse: QuickAccessResponse = {
  system_version: 1,
  system_team_ids: [101],
  user_version: null,
  show_system_recommended: true,
  teams: [],
}

describe('userApis.getQuickAccess', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    removeToken()
  })

  test('deduplicates concurrent quick access requests', async () => {
    let resolveRequest: (value: QuickAccessResponse) => void = () => {}
    ;(apiClient.get as jest.Mock).mockReturnValue(
      new Promise<QuickAccessResponse>(resolve => {
        resolveRequest = resolve
      })
    )

    const firstRequest = userApis.getQuickAccess()
    const secondRequest = userApis.getQuickAccess()

    expect(apiClient.get).toHaveBeenCalledTimes(1)
    expect(apiClient.get).toHaveBeenCalledWith('/users/quick-access')

    resolveRequest(quickAccessResponse)

    await expect(firstRequest).resolves.toBe(quickAccessResponse)
    await expect(secondRequest).resolves.toBe(quickAccessResponse)
  })

  test('shares settled startup data with later mounted consumers until expiry', async () => {
    ;(apiClient.get as jest.Mock).mockResolvedValueOnce(quickAccessResponse).mockResolvedValueOnce({
      ...quickAccessResponse,
      system_version: 2,
    })

    await userApis.getQuickAccess()
    await userApis.getQuickAccess()

    expect(apiClient.get).toHaveBeenCalledTimes(1)
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001)
    try {
      await userApis.getQuickAccess()
    } finally {
      now.mockRestore()
    }

    expect(apiClient.get).toHaveBeenCalledTimes(2)
    expect(apiClient.get).toHaveBeenNthCalledWith(1, '/users/quick-access')
    expect(apiClient.get).toHaveBeenNthCalledWith(2, '/users/quick-access')
  })

  test('invalidates after editing preferences and isolates signed-in users', async () => {
    ;(apiClient.get as jest.Mock).mockResolvedValue(quickAccessResponse)
    ;(apiClient.put as jest.Mock).mockResolvedValue({ id: 1 })
    setToken('first-user')
    await userApis.getQuickAccess()
    await userApis.updateUser({ preferences: { send_key: 'enter' } })
    await userApis.getQuickAccess()
    setToken('second-user')
    await userApis.getQuickAccess()
    expect(apiClient.get).toHaveBeenCalledTimes(3)
  })

  test('does not cache failures or let an old request overwrite newer user data', async () => {
    const error = new Error('Unavailable')
    ;(apiClient.get as jest.Mock).mockRejectedValueOnce(error)
    await expect(userApis.getQuickAccess()).rejects.toBe(error)

    let resolveOld!: (value: QuickAccessResponse) => void
    ;(apiClient.get as jest.Mock).mockReturnValueOnce(
      new Promise(resolve => {
        resolveOld = resolve
      })
    )
    const oldRequest = userApis.getQuickAccess()
    setToken('new-user')
    const updated = { ...quickAccessResponse, system_version: 3 }
    ;(apiClient.get as jest.Mock).mockResolvedValueOnce(updated)
    await userApis.getQuickAccess()
    resolveOld(quickAccessResponse)
    await oldRequest
    await expect(userApis.getQuickAccess()).resolves.toBe(updated)
    expect(apiClient.get).toHaveBeenCalledTimes(3)
  })

  test('loads recent teams from an independent endpoint', async () => {
    ;(apiClient.get as jest.Mock).mockResolvedValueOnce([])

    await userApis.getRecentTeams(true)

    expect(apiClient.get).toHaveBeenCalledWith('/users/recent-teams?is_code=true')
  })
})
