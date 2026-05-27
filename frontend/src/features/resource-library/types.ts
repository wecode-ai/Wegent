// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type ResourceLibraryResourceType = 'agent' | 'skill' | 'mcp'

export type ResourceLibraryTypeFilter = 'all' | ResourceLibraryResourceType

export type ResourceLibraryListingStatus = 'draft' | 'published' | 'archived'

export type ResourceLibraryInstallStatus = 'installed' | 'pending_configuration' | 'failed'

export interface ResourceLibraryVersion {
  id: number
  listing_id?: number
  version: string
  changelog?: string | null
  package_url?: string | null
  created_at: string
  updated_at?: string
}

export interface ResourceLibraryListing {
  id: number
  resource_type: ResourceLibraryResourceType
  name: string
  display_name: string
  description?: string | null
  icon?: string | null
  tags: string[]
  publisher_user_id: number
  status: ResourceLibraryListingStatus | string
  current_version_id?: number | null
  current_version?: ResourceLibraryVersion | null
  install_count: number
  is_installed: boolean
  created_at: string
  updated_at: string
}

export interface ResourceLibraryListListingsParams {
  resourceType?: ResourceLibraryTypeFilter
  keyword?: string
  tags?: string[]
  status?: ResourceLibraryListingStatus | string
  page?: number
  limit?: number
}

export interface ResourceLibraryListResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

export interface ResourceLibraryCreateListingRequest {
  resource_type: ResourceLibraryResourceType
  name: string
  display_name: string
  description?: string
  icon?: string
  tags?: string[]
  source_reference?: Record<string, unknown>
}

export interface ResourceLibraryPublishListingRequest {
  version?: string
  changelog?: string
  package_url?: string
  source_reference?: Record<string, unknown>
}

export interface ResourceLibraryInstallRequest {
  targetNamespace: string
  installOptions?: Record<string, unknown>
}

export interface ResourceLibraryInstallApiRequest {
  target_namespace: string
  install_options?: Record<string, unknown>
}

export interface ResourceLibraryInstalledReference {
  namespace: string
  name: string
  kind?: string
  resource_type?: ResourceLibraryResourceType
}

export interface ResourceLibraryInstallResponse {
  installed_reference: ResourceLibraryInstalledReference
  install_status: ResourceLibraryInstallStatus | string
  requires_configuration: boolean
}

export interface ResourceLibraryInstall {
  id: number
  listing_id: number
  listing?: ResourceLibraryListing
  installed_reference: ResourceLibraryInstalledReference
  install_status: ResourceLibraryInstallStatus | string
  requires_configuration: boolean
  created_at: string
  updated_at: string
}
