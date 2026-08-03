// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from '@/apis/client'
import type {
  ResourceLibraryAgentBindings,
  ResourceLibraryAgentBindingsUpdateRequest,
  ResourceLibraryCreateListingRequest,
  ResourceLibraryInstallApiRequest,
  ResourceLibraryInstallRequest,
  ResourceLibraryInstall,
  ResourceLibraryListListingsParams,
  ResourceLibraryDiscoveryResponse,
  ResourceLibraryListResponse,
  ResourceLibraryListing,
  ResourceLibraryPublicationUpdateRequest,
  ResourceLibraryReferenceUsage,
} from '@/features/resource-library/types'

const RESOURCE_LIBRARY_BASE_PATH = '/resource-library'

function appendQueryParam(params: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null || value === '') {
    return
  }

  if (Array.isArray(value)) {
    if (value.length > 0) {
      params.append(key, value.join(','))
    }
    return
  }

  params.append(key, String(value))
}

function buildListingsQuery(params?: ResourceLibraryListListingsParams): string {
  const query = new URLSearchParams()

  if (params?.resourceType && params.resourceType !== 'all') {
    appendQueryParam(query, 'resource_type', params.resourceType)
  }
  appendQueryParam(query, 'keyword', params?.keyword)
  appendQueryParam(query, 'tags', params?.tags)
  appendQueryParam(query, 'status', params?.status)
  appendQueryParam(query, 'target_namespace', params?.targetNamespace)
  appendQueryParam(query, 'cursor', params?.cursor)
  appendQueryParam(query, 'page', params?.page)
  appendQueryParam(query, 'limit', params?.limit)

  const queryString = query.toString()
  return queryString ? `?${queryString}` : ''
}

function toInstallApiRequest(
  request: ResourceLibraryInstallRequest
): ResourceLibraryInstallApiRequest {
  return {
    version_id: request.versionId,
    target_namespace: request.targetNamespace || 'default',
    install_options: request.installOptions || {},
  }
}

export const resourceLibraryApi = {
  listListings(
    params?: ResourceLibraryListListingsParams
  ): Promise<ResourceLibraryDiscoveryResponse<ResourceLibraryListing>> {
    return apiClient.get(`${RESOURCE_LIBRARY_BASE_PATH}/listings${buildListingsQuery(params)}`)
  },

  getListing(listingId: number): Promise<ResourceLibraryListing> {
    return apiClient.get(`${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}`)
  },

  getPublication(listingId: number): Promise<ResourceLibraryListing> {
    return apiClient.get(`${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}/publication`)
  },

  getPublicationBySource(
    resourceType: string,
    sourceName: string,
    sourceNamespace: string = 'default'
  ): Promise<ResourceLibraryListing> {
    const query = new URLSearchParams({
      resource_type: resourceType,
      source_name: sourceName,
      source_namespace: sourceNamespace,
    })
    return apiClient.get(`${RESOURCE_LIBRARY_BASE_PATH}/publications/source?${query.toString()}`)
  },

  createListing(request: ResourceLibraryCreateListingRequest): Promise<ResourceLibraryListing> {
    return apiClient.post(`${RESOURCE_LIBRARY_BASE_PATH}/listings`, request)
  },

  installListing(
    listingId: number,
    request: ResourceLibraryInstallRequest
  ): Promise<ResourceLibraryInstall> {
    return apiClient.post(
      `${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}/install`,
      toInstallApiRequest(request)
    )
  },

  uninstallListing(listingId: number, targetNamespace: string = 'default'): Promise<void> {
    const query = new URLSearchParams({ target_namespace: targetNamespace })
    return apiClient.delete(
      `${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}/install?${query.toString()}`
    )
  },

  getReferenceUsage(
    listingId: number,
    targetNamespace: string = 'default'
  ): Promise<ResourceLibraryReferenceUsage> {
    const query = new URLSearchParams({ target_namespace: targetNamespace })
    return apiClient.get(
      `${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}/install/usage?${query.toString()}`
    )
  },

  bindAgent(
    agentId: number,
    request: ResourceLibraryInstallRequest
  ): Promise<ResourceLibraryInstall> {
    return apiClient.post(
      `${RESOURCE_LIBRARY_BASE_PATH}/agents/${agentId}/bindings`,
      toInstallApiRequest(request)
    )
  },

  getAgentBindings(agentId: number): Promise<ResourceLibraryAgentBindings> {
    return apiClient.get(`${RESOURCE_LIBRARY_BASE_PATH}/agents/${agentId}/bindings`)
  },

  syncAgentBindings(
    agentId: number,
    request: ResourceLibraryAgentBindingsUpdateRequest
  ): Promise<ResourceLibraryAgentBindings> {
    return apiClient.put(`${RESOURCE_LIBRARY_BASE_PATH}/agents/${agentId}/bindings`, request)
  },

  archiveListing(listingId: number): Promise<ResourceLibraryListing> {
    return apiClient.post(`${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}/archive`)
  },

  updatePublication(
    listingId: number,
    request: ResourceLibraryPublicationUpdateRequest
  ): Promise<ResourceLibraryListing> {
    return apiClient.put(`${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}/publication`, request)
  },

  listMyInstalls(
    params?: ResourceLibraryListListingsParams
  ): Promise<ResourceLibraryListResponse<ResourceLibraryInstall>> {
    return apiClient.get(
      `${RESOURCE_LIBRARY_BASE_PATH}/users/me/installs${buildListingsQuery(params)}`
    )
  },

  listMyPublished(
    params?: ResourceLibraryListListingsParams
  ): Promise<ResourceLibraryListResponse<ResourceLibraryListing>> {
    return apiClient.get(
      `${RESOURCE_LIBRARY_BASE_PATH}/users/me/published${buildListingsQuery(params)}`
    )
  },

  listGroupInstalls(
    groupNamespace: string,
    params?: ResourceLibraryListListingsParams
  ): Promise<ResourceLibraryListResponse<ResourceLibraryInstall>> {
    return apiClient.get(
      `${RESOURCE_LIBRARY_BASE_PATH}/groups/${encodeURIComponent(groupNamespace)}/installs${buildListingsQuery(params)}`
    )
  },
}

export default resourceLibraryApi
