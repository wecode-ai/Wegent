// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { oauthAuthorizationApis, oauthClientAdminApis } from '@/apis/oauthProvider'

jest.mock('@/apis/client', () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}))

const mockedApiClient = apiClient as jest.Mocked<typeof apiClient>

describe('OAuth provider APIs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses the admin OAuth client endpoints', async () => {
    mockedApiClient.get.mockResolvedValue({ items: [], total: 0 })
    mockedApiClient.put.mockResolvedValue({ id: 7 })
    mockedApiClient.delete.mockResolvedValue(undefined)

    await oauthClientAdminApis.getOAuthClients()
    await oauthClientAdminApis.updateOAuthClient(7, { enabled: false })
    await oauthClientAdminApis.deleteOAuthClient(7)

    expect(mockedApiClient.get).toHaveBeenCalledWith('/admin/oauth-clients')
    expect(mockedApiClient.put).toHaveBeenCalledWith('/admin/oauth-clients/7', {
      enabled: false,
    })
    expect(mockedApiClient.delete).toHaveBeenCalledWith('/admin/oauth-clients/7')
  })

  it('encodes authorization request identifiers in decision endpoints', async () => {
    mockedApiClient.get.mockResolvedValue({})
    mockedApiClient.post.mockResolvedValue({ redirect_url: 'https://client.example/callback' })

    await oauthAuthorizationApis.getRequest('request/id')
    await oauthAuthorizationApis.approve('request/id')
    await oauthAuthorizationApis.deny('request/id')

    expect(mockedApiClient.get).toHaveBeenCalledWith('/oauth/authorization-requests/request%2Fid')
    expect(mockedApiClient.post).toHaveBeenNthCalledWith(
      1,
      '/oauth/authorization-requests/request%2Fid/approve'
    )
    expect(mockedApiClient.post).toHaveBeenNthCalledWith(
      2,
      '/oauth/authorization-requests/request%2Fid/deny'
    )
  })
})
