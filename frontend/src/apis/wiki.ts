// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * External wiki API client: connection settings, KB bindings, browse.
 * Design: tmp/2026-09-03-wikijs-mcp-knowledge-design.md (v2.4)
 */

import { apiClient } from './client'

export interface WikiConnectorOption {
  type: string
  display_name: string
}

export interface WikiConnection {
  enabled: boolean
  connector_type: string | null
  site_url: string
  default_locale: string | null
  api_key_masked: string
  available_connectors: WikiConnectorOption[]
}

export interface WikiConnectionSummary extends WikiConnection {
  id: string
  display_name: string
  legacy: boolean
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
  name: string
  path: string
  locale: string
  page_updated_at: string
  resource_url: string
  bound_by: string | null
  bound_at: string | null
  status: string
  connection_id?: string | null
  sync?: boolean
}

export interface WikiBindingCreateResponse {
  documents: WikiBoundDocument[]
  notes: string[]
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
}

export interface WikiPagesResponse {
  pages: WikiPageSummary[]
  next_offset: number | null
  warnings: string[]
}

export const wikiApis = {
  getConnection: async (): Promise<WikiConnection> => {
    return apiClient.get('/wiki/connection')
  },

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

  updateConnection: async (data: WikiConnectionUpdateRequest): Promise<WikiConnection> => {
    return apiClient.put('/wiki/connection', data)
  },

  testConnection: async (data?: WikiConnectionTestRequest): Promise<WikiConnectionTestResponse> => {
    return apiClient.post('/wiki/connection/test', data ?? {})
  },

  listKbWikiDocuments: async (knowledgeBaseId: number): Promise<WikiBoundDocument[]> => {
    return apiClient.get(`/knowledge/${knowledgeBaseId}/wiki-bindings`)
  },

  bindKbWikiDocuments: async (
    knowledgeBaseId: number,
    paths: string[],
    options?: { connectionId?: string; sync?: boolean; folderId?: number }
  ): Promise<WikiBindingCreateResponse> => {
    return apiClient.post(`/knowledge/${knowledgeBaseId}/wiki-bindings`, {
      paths,
      connection_id: options?.connectionId,
      sync: options?.sync ?? false,
      folder_id: options?.folderId ?? 0,
    })
  },

  unbindKbWikiDocument: async (knowledgeBaseId: number, documentId: number): Promise<void> => {
    return apiClient.delete(`/knowledge/${knowledgeBaseId}/wiki-bindings/${documentId}`)
  },

  listPages: async (params: {
    kb_id?: number
    path?: string
    locale?: string
    limit?: number
    offset?: number
    refresh?: boolean
    connection_id?: string
  }): Promise<WikiPagesResponse> => {
    const query = new URLSearchParams()
    if (params.kb_id != null) query.set('kb_id', String(params.kb_id))
    if (params.path) query.set('path', params.path)
    if (params.locale) query.set('locale', params.locale)
    if (params.limit != null) query.set('limit', String(params.limit))
    if (params.offset != null) query.set('offset', String(params.offset))
    if (params.refresh) query.set('refresh', 'true')
    if (params.connection_id) query.set('connection_id', params.connection_id)
    const suffix = query.toString()
    return apiClient.get(`/wiki/pages${suffix ? `?${suffix}` : ''}`)
  },
}
