// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { oauthAuthorizationApis, oauthClientAdminApis, oauthClientApis } from '@/apis/oauthProvider'

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

  it('uses owner-scoped OAuth client endpoints for self-service management', async () => {
    const payload = {
      name: 'Example App',
      client_type: 'confidential' as const,
      redirect_uris: ['http://localhost:3100/callback'],
    }
    mockedApiClient.get.mockResolvedValue({ items: [], total: 0 })
    mockedApiClient.post.mockResolvedValue({ id: 7 })
    mockedApiClient.put.mockResolvedValue({ id: 7 })
    mockedApiClient.delete.mockResolvedValue(undefined)

    await oauthClientApis.getOAuthClients()
    await oauthClientApis.createOAuthClient(payload)
    await oauthClientApis.updateOAuthClient(7, payload)
    await oauthClientApis.rotateOAuthClientSecret(7)
    await oauthClientApis.deleteOAuthClient(7)

    expect(mockedApiClient.get).toHaveBeenCalledWith('/oauth-clients')
    expect(mockedApiClient.post).toHaveBeenNthCalledWith(1, '/oauth-clients', payload)
    expect(mockedApiClient.put).toHaveBeenCalledWith('/oauth-clients/7', payload)
    expect(mockedApiClient.post).toHaveBeenNthCalledWith(2, '/oauth-clients/7/rotate-secret')
    expect(mockedApiClient.delete).toHaveBeenCalledWith('/oauth-clients/7')
  })

  it('encodes authorization request identifiers in decision endpoints', async () => {
    mockedApiClient.get.mockResolvedValue({})
    mockedApiClient.post.mockResolvedValue({ redirect_url: 'https://client.example/callback' })

    await oauthAuthorizationApis.getRequest('request/id')
    await oauthAuthorizationApis.approve('request/id')
    await oauthAuthorizationApis.deny('request/id')

    expect(mockedApiClient.get).toHaveBeenCalledWith(
      '/external/oauth/authorization-requests/request%2Fid'
    )
    expect(mockedApiClient.post).toHaveBeenNthCalledWith(
      1,
      '/external/oauth/authorization-requests/request%2Fid/approve'
    )
    expect(mockedApiClient.post).toHaveBeenNthCalledWith(
      2,
      '/external/oauth/authorization-requests/request%2Fid/deny'
    )
  })
})
