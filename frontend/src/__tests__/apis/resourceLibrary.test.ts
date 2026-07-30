// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

jest.mock('@/apis/client', () => ({
  __esModule: true,
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
  },
  default: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
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
    mockedApiClient.get.mockResolvedValue({
      items: [],
      has_more: true,
      next_cursor: 'next-page',
      limit: 10,
    })

    await resourceLibraryApi.listListings({
      resourceType: 'skill',
      keyword: 'summary',
      targetNamespace: 'engineering',
      cursor: 'current-page',
      limit: 10,
    })

    expect(mockedApiClient.get).toHaveBeenCalledWith(
      '/resource-library/listings?resource_type=skill&keyword=summary&target_namespace=engineering&cursor=current-page&limit=10'
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
      installed_at: '2026-05-27T00:00:00',
      updated_at: '2026-05-27T00:00:00',
    })

    await resourceLibraryApi.installListing(7, {})

    expect(mockedApiClient.post).toHaveBeenCalledWith('/resource-library/listings/7/install', {
      target_namespace: 'default',
      install_options: {},
    })
  })

  it('binds an owned agent to a target scope by reference', async () => {
    mockedApiClient.post.mockResolvedValue({
      id: 2,
      listing_id: 7,
      version_id: 7,
      user_id: 2,
      resource_type: 'agent',
      installed_kind_id: 7,
      installed_reference: {
        namespace: 'engineering',
        name: 'agent',
        team_id: 7,
      },
      install_status: 'installed',
      installed_at: '2026-05-27T00:00:00',
      updated_at: '2026-05-27T00:00:00',
    })

    await resourceLibraryApi.bindAgent(7, {
      targetNamespace: 'engineering',
    })

    expect(mockedApiClient.post).toHaveBeenCalledWith('/resource-library/agents/7/bindings', {
      target_namespace: 'engineering',
      install_options: {},
    })
  })

  it('loads and replaces all group bindings for an owned agent', async () => {
    mockedApiClient.get.mockResolvedValue({
      agent_id: 7,
      personal: false,
      group_names: ['group-one', 'group-two'],
    })
    mockedApiClient.put.mockResolvedValue({
      agent_id: 7,
      personal: false,
      group_names: ['group-one'],
    })

    await resourceLibraryApi.getAgentBindings(7)
    await resourceLibraryApi.syncAgentBindings(7, {
      group_names: ['group-one'],
    })

    expect(mockedApiClient.get).toHaveBeenCalledWith('/resource-library/agents/7/bindings')
    expect(mockedApiClient.put).toHaveBeenCalledWith('/resource-library/agents/7/bindings', {
      group_names: ['group-one'],
    })
  })

  it('loads published resources for current user', async () => {
    mockedApiClient.get.mockResolvedValue({ items: [], total: 0 })

    await resourceLibraryApi.listMyPublished({ resourceType: 'agent', page: 1, limit: 20 })

    expect(mockedApiClient.get).toHaveBeenCalledWith(
      '/resource-library/users/me/published?resource_type=agent&page=1&limit=20'
    )
  })

  it('loads editable publication settings for an owned resource', async () => {
    mockedApiClient.get.mockResolvedValue({ id: 92, target_groups: ['team-a'] })

    await resourceLibraryApi.getPublication(92)

    expect(mockedApiClient.get).toHaveBeenCalledWith('/resource-library/listings/92/publication')
  })

  it('loads installed resources for current user', async () => {
    mockedApiClient.get.mockResolvedValue({ items: [], total: 0 })

    await resourceLibraryApi.listMyInstalls({ resourceType: 'skill', page: 1, limit: 20 })

    expect(mockedApiClient.get).toHaveBeenCalledWith(
      '/resource-library/users/me/installs?resource_type=skill&page=1&limit=20'
    )
  })
})
