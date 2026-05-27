// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from '@/apis/client'
import type {
  ResourceLibraryCreateListingRequest,
  ResourceLibraryInstall,
  ResourceLibraryInstallApiRequest,
  ResourceLibraryInstallRequest,
  ResourceLibraryInstallResponse,
  ResourceLibraryListListingsParams,
  ResourceLibraryListResponse,
  ResourceLibraryListing,
  ResourceLibraryPublishListingRequest,
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
  appendQueryParam(query, 'page', params?.page)
  appendQueryParam(query, 'limit', params?.limit)

  const queryString = query.toString()
  return queryString ? `?${queryString}` : ''
}

function toInstallApiRequest(
  request: ResourceLibraryInstallRequest
): ResourceLibraryInstallApiRequest {
  return {
    target_namespace: request.targetNamespace,
    install_options: request.installOptions,
  }
}

export const resourceLibraryApi = {
  listListings(
    params?: ResourceLibraryListListingsParams
  ): Promise<ResourceLibraryListResponse<ResourceLibraryListing>> {
    return apiClient.get(`${RESOURCE_LIBRARY_BASE_PATH}/listings${buildListingsQuery(params)}`)
  },

  getListing(listingId: number): Promise<ResourceLibraryListing> {
    return apiClient.get(`${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}`)
  },

  createListing(request: ResourceLibraryCreateListingRequest): Promise<ResourceLibraryListing> {
    return apiClient.post(`${RESOURCE_LIBRARY_BASE_PATH}/listings`, request)
  },

  publishListing(
    listingId: number,
    request: ResourceLibraryPublishListingRequest
  ): Promise<ResourceLibraryListing> {
    return apiClient.post(`${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}/publish`, request)
  },

  installListing(
    listingId: number,
    request: ResourceLibraryInstallRequest
  ): Promise<ResourceLibraryInstallResponse> {
    return apiClient.post(
      `${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}/install`,
      toInstallApiRequest(request)
    )
  },

  archiveListing(listingId: number): Promise<ResourceLibraryListing> {
    return apiClient.post(`${RESOURCE_LIBRARY_BASE_PATH}/listings/${listingId}/archive`)
  },

  listMyInstalls(): Promise<ResourceLibraryListResponse<ResourceLibraryInstall>> {
    return apiClient.get(`${RESOURCE_LIBRARY_BASE_PATH}/users/me/installs`)
  },

  listMyPublished(): Promise<ResourceLibraryListResponse<ResourceLibraryListing>> {
    return apiClient.get(`${RESOURCE_LIBRARY_BASE_PATH}/users/me/listings`)
  },
}

export default resourceLibraryApi
