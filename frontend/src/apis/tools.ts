// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

// Tool Types
export type ToolTypeEnum = 'public' | 'user' | 'group'
export type ToolKindType = 'builtin' | 'mcp'
export type McpServerType = 'stdio' | 'sse' | 'streamable-http'

export interface McpServerConfig {
  type: McpServerType
  url?: string | null
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  headers?: Record<string, string> | null
  timeout?: number | null
}

export interface UnifiedTool {
  name: string
  type: ToolTypeEnum // 'public', 'user', or 'group' - identifies tool source
  displayName?: string | null
  toolType: ToolKindType // 'builtin' or 'mcp'
  description: string
  builtinName?: string | null
  mcpServer?: McpServerConfig | null
  parameters?: Record<string, unknown> | null
  namespace?: string // Resource namespace (group name or 'default')
}

export interface ToolListResponse {
  data: UnifiedTool[]
}

export interface ToolCreateRequest {
  name: string
  displayName?: string
  type: ToolKindType // 'builtin' or 'mcp'
  description: string
  builtinName?: string // Required for builtin type
  mcpServer?: McpServerConfig // Required for mcp type
  parameters?: Record<string, unknown>
}

export interface ToolUpdateRequest {
  displayName?: string
  description?: string
  mcpServer?: McpServerConfig
  parameters?: Record<string, unknown>
}

// Tool Services
export const toolApis = {
  /**
   * Get list of all available tools with scope support
   *
   * Each tool includes a 'type' field ('public', 'user', or 'group') to identify its source.
   * @param scope - Resource scope: 'personal', 'group', or 'all'
   * @param groupName - Group name (required when scope is 'group')
   * @param toolType - Filter by tool type: 'builtin' or 'mcp'
   */
  async getTools(
    scope?: 'personal' | 'group' | 'all',
    groupName?: string,
    toolType?: ToolKindType
  ): Promise<ToolListResponse> {
    const params = new URLSearchParams()
    if (scope) {
      params.append('scope', scope)
    }
    if (groupName) {
      params.append('group_name', groupName)
    }
    if (toolType) {
      params.append('tool_type', toolType)
    }
    const queryString = params.toString()
    return apiClient.get(`/tools${queryString ? `?${queryString}` : ''}`)
  },

  /**
   * Get unified list of all available tools (public + user + group)
   */
  async getUnifiedTools(
    scope: 'personal' | 'group' | 'all' = 'all',
    groupName?: string
  ): Promise<ToolListResponse> {
    const params = new URLSearchParams()
    params.append('scope', scope)
    if (groupName) {
      params.append('group_name', groupName)
    }
    const queryString = params.toString()
    return apiClient.get(`/tools/unified?${queryString}`)
  },

  /**
   * Get tools compatible with a specific Shell
   *
   * @param shellName - Shell name to check compatibility
   */
  async getCompatibleTools(shellName: string): Promise<ToolListResponse> {
    return apiClient.get(`/tools/compatible?shell_name=${encodeURIComponent(shellName)}`)
  },

  /**
   * Get a specific tool by name
   *
   * @param toolName - Tool name
   */
  async getTool(toolName: string): Promise<UnifiedTool> {
    return apiClient.get(`/tools/${encodeURIComponent(toolName)}`)
  },

  /**
   * Create a new user-defined tool
   * @param request - Tool creation data
   * @param groupName - Optional group name to create tool in group scope
   */
  async createTool(request: ToolCreateRequest, groupName?: string): Promise<UnifiedTool> {
    const params = new URLSearchParams()
    if (groupName) {
      params.append('group_name', groupName)
    }
    const queryString = params.toString()
    return apiClient.post(`/tools${queryString ? `?${queryString}` : ''}`, request)
  },

  /**
   * Update an existing user-defined tool
   */
  async updateTool(name: string, request: ToolUpdateRequest): Promise<UnifiedTool> {
    return apiClient.put(`/tools/${encodeURIComponent(name)}`, request)
  },

  /**
   * Delete a user-defined tool
   */
  async deleteTool(name: string): Promise<void> {
    return apiClient.delete(`/tools/${encodeURIComponent(name)}`)
  },

  /**
   * Get public tools only (filter from unified list)
   */
  async getPublicTools(): Promise<UnifiedTool[]> {
    const response = await this.getTools()
    return (response.data || []).filter(tool => tool.type === 'public')
  },

  /**
   * Get MCP type tools only
   */
  async getMcpTools(): Promise<UnifiedTool[]> {
    const response = await this.getTools(undefined, undefined, 'mcp')
    return response.data || []
  },

  /**
   * Get builtin type tools only
   */
  async getBuiltinTools(): Promise<UnifiedTool[]> {
    const response = await this.getTools(undefined, undefined, 'builtin')
    return response.data || []
  },
}
