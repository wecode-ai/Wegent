// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** External Wiki API client for connection settings and synchronized imports. */

import { apiClient } from './client'

export interface WikiConnectorOption {
  type: string
  display_name: string
  capabilities?: WikiConnectorCapabilities
}

export interface WikiConnectorCapabilities {
  resource_kind: 'page' | 'file'
  supports_locale: boolean
  supports_project_selection: boolean
  supports_branch_selection: boolean
  supports_scheduled_sync: boolean
}

export interface WikiConnection {
  enabled: boolean
  connector_type: string | null
  site_url: string
  default_locale: string | null
  api_key_masked: string
  capabilities?: WikiConnectorCapabilities
  available_connectors: WikiConnectorOption[]
}

export interface WikiConnectionSummary extends WikiConnection {
  id: string
  display_name: string
}

export interface WikiConnectionsResponse {
  connections: WikiConnectionSummary[]
  available_connectors: WikiConnectorOption[]
}

export interface WikiConnectionUpdateRequest {
  connector_type: string
  site_url: string
  api_key?: string
  default_locale?: string | null
  enabled: boolean
}

export interface WikiNamedConnectionUpdateRequest extends WikiConnectionUpdateRequest {
  display_name: string
}

export interface WikiConnectionTestRequest {
  connection_id?: string
  connector_type?: string
  site_url?: string
  api_key?: string
  default_locale?: string | null
}

export interface WikiConnectionTestResponse {
  ok: boolean
  message: string
  version: string | null
}

export interface WikiBoundDocument {
  id: number
  page_id: string
  name: string
  path: string
  locale: string
  page_updated_at: string
  resource_url: string
  status: string
  connection_id?: string | null
  adapter_type?: string
  resource_kind?: 'page' | 'file'
  project_path?: string | null
  branch?: string | null
  file_extension?: string
}

export interface WikiBindingCreateResponse {
  documents: WikiBoundDocument[]
  duplicate_documents: WikiBoundDocument[]
  created_count: number
  updated_count: number
  processing_count: number
}

export interface WikiPageSummary {
  id: string
  path: string
  title: string
  description: string
  updated_at: string
  tags: string[]
  locale: string
  is_published: boolean
  page_url: string
  resource_kind?: 'page' | 'file'
  resource_key?: string
  file_extension?: string
  importable?: boolean
  unsupported_reason?: string | null
  is_directory?: boolean
}

export interface WikiPagesResponse {
  pages: WikiPageSummary[]
  next_offset: number | null
  warnings: string[]
}

export interface WikiProjectSummary {
  path: string
  name: string
  default_branch: string | null
  web_url: string
}

export interface WikiBranchSummary {
  name: string
  is_default: boolean
}

export const wikiApis = {
  listConnections: async (): Promise<WikiConnectionsResponse> => {
    return apiClient.get('/wiki/connections')
  },

  createConnection: async (
    data: WikiNamedConnectionUpdateRequest
  ): Promise<WikiConnectionSummary> => {
    return apiClient.post('/wiki/connections', data)
  },

  updateNamedConnection: async (
    connectionId: string,
    data: WikiNamedConnectionUpdateRequest
  ): Promise<WikiConnectionSummary> => {
    return apiClient.put(`/wiki/connections/${connectionId}`, data)
  },

  deleteConnection: async (connectionId: string): Promise<void> => {
    return apiClient.delete(`/wiki/connections/${connectionId}`)
  },

  testConnection: async (data?: WikiConnectionTestRequest): Promise<WikiConnectionTestResponse> => {
    return apiClient.post('/wiki/connection/test', data ?? {})
  },

  listKbWikiDocuments: async (knowledgeBaseId: number): Promise<WikiBoundDocument[]> => {
    return apiClient.get(`/knowledge/${knowledgeBaseId}/wiki-bindings`)
  },

  bindKbWikiDocuments: async (
    knowledgeBaseId: number,
    pageIds: string[],
    options: {
      connectionId: string
      folderId?: number
      projectPath?: string
      branch?: string
    }
  ): Promise<WikiBindingCreateResponse> => {
    return apiClient.post(`/knowledge/${knowledgeBaseId}/wiki-bindings`, {
      page_ids: pageIds,
      connection_id: options.connectionId,
      project_path: options.projectPath || null,
      branch: options.branch || null,
      folder_id: options?.folderId ?? 0,
    })
  },

  unbindKbWikiDocument: async (knowledgeBaseId: number, documentId: number): Promise<void> => {
    return apiClient.delete(`/knowledge/${knowledgeBaseId}/wiki-bindings/${documentId}`)
  },

  listPages: async (params: {
    path?: string
    locale?: string
    limit?: number
    offset?: number
    refresh?: boolean
    connection_id?: string
    project_path?: string
    branch?: string
  }): Promise<WikiPagesResponse> => {
    const query = new URLSearchParams()
    if (params.path) query.set('path', params.path)
    if (params.locale) query.set('locale', params.locale)
    if (params.limit != null) query.set('limit', String(params.limit))
    if (params.offset != null) query.set('offset', String(params.offset))
    if (params.refresh) query.set('refresh', 'true')
    if (params.connection_id) query.set('connection_id', params.connection_id)
    if (params.project_path) query.set('project_path', params.project_path)
    if (params.branch) query.set('branch', params.branch)
    const suffix = query.toString()
    return apiClient.get(`/wiki/pages${suffix ? `?${suffix}` : ''}`)
  },

  listProjects: async (params: {
    connection_id: string
    search?: string
    limit?: number
    offset?: number
  }): Promise<{ projects: WikiProjectSummary[]; next_offset: number | null }> => {
    const query = new URLSearchParams({ connection_id: params.connection_id })
    if (params.search) query.set('search', params.search)
    if (params.limit != null) query.set('limit', String(params.limit))
    if (params.offset != null) query.set('offset', String(params.offset))
    return apiClient.get(`/wiki/projects?${query}`)
  },

  listBranches: async (params: {
    connection_id: string
    project_path: string
    limit?: number
    offset?: number
  }): Promise<{ branches: WikiBranchSummary[]; next_offset: number | null }> => {
    const query = new URLSearchParams({
      connection_id: params.connection_id,
      project_path: params.project_path,
    })
    if (params.limit != null) query.set('limit', String(params.limit))
    if (params.offset != null) query.set('offset', String(params.offset))
    return apiClient.get(`/wiki/branches?${query}`)
  },
}
