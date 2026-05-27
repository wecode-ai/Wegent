// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

jest.mock('@/apis/client', () => ({
  __esModule: true,
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
  },
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}))

import apiClient from '@/apis/client'
import { resourceLibraryApi } from '@/apis/resourceLibrary'

const mockedApiClient = apiClient as jest.Mocked<typeof apiClient>

describe('resourceLibraryApi', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('lists listings with resource type, keyword, and pagination query params', async () => {
    mockedApiClient.get.mockResolvedValue({ items: [], total: 0, page: 2, limit: 10 })

    await resourceLibraryApi.listListings({
      resourceType: 'skill',
      keyword: 'summary',
      page: 2,
      limit: 10,
    })

    expect(mockedApiClient.get).toHaveBeenCalledWith(
      '/resource-library/listings?resource_type=skill&keyword=summary&page=2&limit=10'
    )
  })

  it('installs a listing with target namespace and install options', async () => {
    mockedApiClient.post.mockResolvedValue({
      id: 1,
      listing_id: 7,
      version_id: 3,
      user_id: 2,
      resource_type: 'skill',
      installed_kind_id: 8,
      installed_reference: { namespace: 'default', name: 'summary' },
      install_status: 'installed',
      requires_configuration: false,
      installed_at: '2026-05-27T00:00:00',
      updated_at: '2026-05-27T00:00:00',
    })

    await resourceLibraryApi.installListing(7, {
      targetNamespace: 'default',
      installOptions: {},
    })

    expect(mockedApiClient.post).toHaveBeenCalledWith('/resource-library/listings/7/install', {
      target_namespace: 'default',
      install_options: {},
    })
  })

  it('defaults install request namespace and options', async () => {
    mockedApiClient.post.mockResolvedValue({
      id: 1,
      listing_id: 7,
      version_id: 3,
      user_id: 2,
      resource_type: 'agent',
      installed_kind_id: 8,
      installed_reference: { namespace: 'default', name: 'agent' },
      install_status: 'installed',
      requires_configuration: false,
      installed_at: '2026-05-27T00:00:00',
      updated_at: '2026-05-27T00:00:00',
    })

    await resourceLibraryApi.installListing(7, {})

    expect(mockedApiClient.post).toHaveBeenCalledWith('/resource-library/listings/7/install', {
      target_namespace: 'default',
      install_options: {},
    })
  })

  it('loads published resources for current user', async () => {
    mockedApiClient.get.mockResolvedValue({ items: [], total: 0 })

    await resourceLibraryApi.listMyPublished({ resourceType: 'agent', page: 1, limit: 20 })

    expect(mockedApiClient.get).toHaveBeenCalledWith(
      '/resource-library/users/me/published?resource_type=agent&page=1&limit=20'
    )
  })

  it('loads installed resources for current user', async () => {
    mockedApiClient.get.mockResolvedValue({ items: [], total: 0 })

    await resourceLibraryApi.listMyInstalls({ resourceType: 'mcp', page: 1, limit: 20 })

    expect(mockedApiClient.get).toHaveBeenCalledWith(
      '/resource-library/users/me/installs?resource_type=mcp&page=1&limit=20'
    )
  })
})
