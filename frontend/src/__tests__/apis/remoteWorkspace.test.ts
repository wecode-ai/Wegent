// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { remoteWorkspaceApis } from '@/apis/remoteWorkspace'
import { apiClient } from '@/apis/client'

jest.mock('@/apis/client', () => ({
  apiClient: {
    get: jest.fn(),
  },
}))

describe('remoteWorkspaceApis', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('builds status url correctly', async () => {
    ;(apiClient.get as jest.Mock).mockResolvedValue({
      connected: true,
      available: true,
      root_path: '/workspace',
      reason: null,
    })

    await remoteWorkspaceApis.getStatus(12)

    expect(apiClient.get).toHaveBeenCalledWith('/tasks/12/remote-workspace/status')
  })
})
