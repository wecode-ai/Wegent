// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from './client'

export interface MCPProvider {
  key: string
  name: string
  name_en?: string
  description: string
  discover_url: string
  api_key_url: string
  token_field_name: string
  has_token: boolean
}

export interface MCPServer {
  id: string
  name: string
  description?: string
  type: string
  base_url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  is_active: boolean
  provider: string
  provider_url?: string
  logo_url?: string
  tags?: string[]
}

export interface MCPProviderKeysRequest {
  bailian?: string
  modelscope?: string
  mcp_router?: string
}

export interface MCPProviderKeysResponse {
  success: boolean
  message: string
}

export interface MCPProviderListResponse {
  providers: MCPProvider[]
}

export interface MCPServerListResponse {
  success: boolean
  message: string
  servers: MCPServer[]
  error_details?: string
}

export const mcpProviderApis = {
  /** Get list of MCP providers */
  getProviders: async (): Promise<MCPProviderListResponse> => {
    return apiClient.get<MCPProviderListResponse>('/mcp-providers')
  },

  /** Sync MCP servers from a provider */
  syncServers: async (providerKey: string): Promise<MCPServerListResponse> => {
    return apiClient.post<MCPServerListResponse>(`/mcp-providers/${providerKey}/servers`)
  },

  /** Update MCP provider API keys */
  updateKeys: async (data: MCPProviderKeysRequest): Promise<MCPProviderKeysResponse> => {
    return apiClient.put<MCPProviderKeysResponse>('/mcp-providers/keys', data)
  },
}
