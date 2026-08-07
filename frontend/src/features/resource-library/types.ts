// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type ResourceLibraryResourceType =
  | 'agent'
  | 'skill'
  | 'model'
  | 'shell'
  | 'retriever'
  | 'mcp'

export type VisibleResourceLibraryResourceType = Exclude<ResourceLibraryResourceType, 'mcp'>

export type ManagedResourceType = 'agent' | 'model' | 'shell' | 'skill' | 'retriever'

export type ResourceLibraryTab = 'discover' | 'mine' | 'team' | 'system' | 'published'

export type ResourceLibraryModelCategoryFilter = 'all' | 'llm' | 'embedding' | 'rerank'

export type ResourceLibraryTypeFilter = 'all' | ManagedResourceType

export type MarketplaceResourceLibraryTypeFilter = 'all' | VisibleResourceLibraryResourceType

export type ManagedResourceSourceFilter = 'all' | 'mine' | 'personal' | 'group' | 'system'

export type ResourceLibraryListingStatus = 'published' | 'archived'

export type ResourceLibraryInstallStatus = 'installed' | 'removed' | 'failed'

export interface ResourceLibraryVersion {
  id: number
  listing_id?: number
  version: string
  changelog?: string | null
  package_url?: string | null
  created_at: string
  updated_at?: string
}

export interface MarketplaceExampleConversation {
  title: string
  url: string
}

export interface ResourceLibraryListing {
  id: number
  resource_type: ResourceLibraryResourceType
  name: string
  display_name: string
  description?: string | null
  icon?: string | null
  tags: string[]
  feature_tags?: string[]
  publisher_user_id: number
  publisher_user_name?: string | null
  publisher_namespace?: string
  status: ResourceLibraryListingStatus | string
  current_version_id?: number | null
  current_version?: ResourceLibraryVersion | null
  install_count: number
  is_installed: boolean
  example_conversations?: MarketplaceExampleConversation[]
  bind_modes: string[]
  allow_personal_install?: boolean
  allow_group_install?: boolean
  target_groups?: string[]
  created_at: string
  updated_at: string
}

export interface ResourceLibraryPublicationUpdateRequest {
  display_name?: string
  description?: string | null
  icon?: string | null
  tags?: string[]
  version?: string
  status?: ResourceLibraryListingStatus
  allow_personal_install?: boolean
  allow_group_install?: boolean
  target_groups?: string[]
  example_conversations?: MarketplaceExampleConversation[]
}

export interface ResourceLibraryReferenceConsumer {
  id: number
  name: string
  namespace: string
}

export interface ResourceLibraryReferenceUsage {
  referenced_bots: ResourceLibraryReferenceConsumer[]
  referenced_knowledge_bases: ResourceLibraryReferenceConsumer[]
}

export interface ResourceLibraryListListingsParams {
  resourceType?: MarketplaceResourceLibraryTypeFilter
  keyword?: string
  tags?: string[]
  status?: ResourceLibraryListingStatus | string
  systemOnly?: boolean
  featuredOnly?: boolean
  targetNamespace?: string
  cursor?: string
  page?: number
  limit?: number
}

export interface ResourceLibraryDiscoveryResponse<T> {
  items: T[]
  has_more: boolean
  next_cursor: string | null
  limit: number
}

export interface ResourceLibraryListResponse<T> {
  items: T[]
  total: number
  page?: number
  limit?: number
}

export interface ResourceLibraryCreateListingRequest {
  resource_type: ResourceLibraryResourceType
  source_id?: number
  source_name?: string
  source_namespace?: string
  name: string
  display_name: string
  description?: string | null
  icon?: string | null
  tags: string[]
  version: string
  status?: ResourceLibraryListingStatus
  target_groups?: string[]
  allow_personal_install?: boolean
  allow_group_install?: boolean
  example_conversations?: MarketplaceExampleConversation[]
  manifest_options?: Record<string, unknown>
}

export interface ResourceLibraryInstallRequest {
  targetNamespace?: string
  versionId?: number
  installOptions?: Record<string, unknown>
}

export interface ResourceLibraryInstallApiRequest {
  target_namespace: string
  version_id?: number
  install_options?: Record<string, unknown>
}

export interface ResourceLibraryAgentBindings {
  agent_id: number
  personal: boolean
  group_names: string[]
}

export interface ResourceLibraryAgentBindingsUpdateRequest {
  group_names: string[]
}

export interface ResourceLibraryInstalledReference {
  namespace?: string
  name?: string
  kind?: string
  team_id?: number
  skill_id?: number
  service_id?: string
  provider_id?: string
  server_name?: string
  resource_type?: ResourceLibraryResourceType
  [key: string]: unknown
}

export interface ResourceLibraryInstall {
  id: number
  listing_id: number
  version_id: number
  user_id: number
  resource_type: ResourceLibraryResourceType
  listing?: ResourceLibraryListing
  installed_kind_id?: number | null
  installed_reference: ResourceLibraryInstalledReference
  install_status: ResourceLibraryInstallStatus
  error_message?: string | null
  installed_at: string
  updated_at: string
}

export type ResourceLibraryInstallResponse = ResourceLibraryInstall
