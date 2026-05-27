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
      installed_reference: { namespace: 'default', name: 'summary' },
      install_status: 'installed',
      requires_configuration: false,
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
})
