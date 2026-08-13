// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

jest.mock('@/apis/client', () => ({
  apiClient: {
    delete: jest.fn(),
    put: jest.fn(),
  },
}))

import { apiClient } from '@/apis/client'
import { teamApis } from '@/apis/team'

const mockedApiClient = apiClient as jest.Mocked<typeof apiClient>

describe('team identity confirmation API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('sends the current technical name when forcing an identity change', async () => {
    mockedApiClient.put.mockResolvedValue({ id: 1 })

    await teamApis.updateTeam(
      1,
      {
        name: 'renamed-agent',
      },
      {
        forceIdentityChange: true,
        confirmName: 'old agent',
      }
    )

    expect(mockedApiClient.put).toHaveBeenCalledWith(
      '/teams/1?force_identity_change=true&confirm_name=old+agent',
      {
        name: 'renamed-agent',
      }
    )
  })

  it('sends destructive deletion confirmation without checking tasks', async () => {
    mockedApiClient.delete.mockResolvedValue(undefined)

    await teamApis.deleteTeam(1, 'old agent')

    expect(mockedApiClient.delete).toHaveBeenCalledWith(
      '/teams/1?force=true&confirm_name=old+agent'
    )
  })
})
