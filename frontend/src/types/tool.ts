// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Tool Types

export type ToolType = 'mcp' | 'builtin'
export type ToolVisibility = 'personal' | 'team' | 'public'
export type ToolStatus = 'available' | 'pending_config' | 'disabled'

// Environment variable schema for MCP tools
export interface EnvSchemaItem {
  name: string
  displayName?: string
  description?: string
  required: boolean
  secret: boolean
  default?: string
}

// MCP server configuration
export interface MCPConfig {
  serverType: 'stdio' | 'sse' | 'streamable-http'
  args?: string[]
  url?: string
  envSchema?: EnvSchemaItem[]
}

// Builtin tool configuration
export interface BuiltinConfig {
  toolId: string
}

// Tool definition
export interface Tool {
  id: number
  name: string
  namespace: string
  type: ToolType
  visibility: ToolVisibility
  category?: string
  tags?: string[]
  description?: string
  mcp_config?: MCPConfig
  builtin_config?: BuiltinConfig
  user_id: number
  is_active: boolean
  created_at: string
  updated_at: string
}

// Tool for market display (simplified)
export interface ToolMarketItem {
  id: number
  name: string
  type: ToolType
  category?: string
  tags?: string[]
  description?: string
  mcp_config?: MCPConfig
  builtin_config?: BuiltinConfig
}

// Tool list response
export interface ToolListResponse {
  total: number
  items: Tool[]
}

// Tool market list response
export interface ToolMarketListResponse {
  total: number
  items: ToolMarketItem[]
  categories: string[]
}

// Ghost tool reference
export interface GhostToolRef {
  toolRef: string
  status: ToolStatus
}

// Ghost tool detail (with full tool info)
export interface GhostToolDetail {
  tool_id: number
  tool_name: string
  status: ToolStatus
  tool?: ToolMarketItem
  has_secrets: boolean
  secret_configured: boolean
}

// Tool secret configuration
export interface ToolSecretConfig {
  env: Record<string, string>
}

// Create tool request
export interface ToolCreate {
  name: string
  type: ToolType
  visibility?: ToolVisibility
  category?: string
  tags?: string[]
  description?: string
  mcp_config?: MCPConfig
  builtin_config?: BuiltinConfig
}

// Update tool request
export interface ToolUpdate {
  name?: string
  visibility?: ToolVisibility
  category?: string
  tags?: string[]
  description?: string
  mcp_config?: MCPConfig
  builtin_config?: BuiltinConfig
}

// Tool categories response
export interface ToolCategoryResponse {
  categories: string[]
}
