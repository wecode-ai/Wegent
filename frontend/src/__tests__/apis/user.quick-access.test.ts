// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { userApis } from '@/apis/user'
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

  test('starts a fresh quick access request after the previous one settles', async () => {
    ;(apiClient.get as jest.Mock).mockResolvedValueOnce(quickAccessResponse).mockResolvedValueOnce({
      ...quickAccessResponse,
      system_version: 2,
    })

    await userApis.getQuickAccess()
    await userApis.getQuickAccess()

    expect(apiClient.get).toHaveBeenCalledTimes(2)
    expect(apiClient.get).toHaveBeenNthCalledWith(1, '/users/quick-access')
    expect(apiClient.get).toHaveBeenNthCalledWith(2, '/users/quick-access')
  })
})
