// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill types for unified skill management (MCP tools, builtin tools, Claude Code skills)
 */

// Skill type enum
export type SkillType = 'skill' | 'mcp' | 'builtin'

// Skill visibility levels
export type SkillVisibility = 'personal' | 'team' | 'public'

// Skill status in Ghost
export type SkillStatus = 'available' | 'pending_config' | 'disabled'

// Environment variable schema item
export interface EnvSchemaItem {
  name: string
  displayName?: string
  description?: string
  required: boolean
  secret: boolean // Whether this is a sensitive field (API key, token, etc.)
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

// Skill data from API
export interface MarketSkill {
  id: number
  name: string
  description: string
  version?: string
  author?: string
  tags?: string[]
  skillType: SkillType
  visibility: SkillVisibility
  category?: string
  mcpConfig?: MCPConfig
  builtinConfig?: BuiltinConfig
  createdAt?: string
  updatedAt?: string
}

// Skill in Ghost with status
export interface GhostSkill extends MarketSkill {
  status: SkillStatus
  hassecret: boolean
}

// Skill list response
export interface SkillListResponse {
  items: MarketSkill[]
  total: number
  page: number
  pageSize: number
}

// Category list response
export interface CategoryListResponse {
  categories: string[]
}

// secrets response
export interface secretsResponse {
  envSchema: EnvSchemaItem[]
  values: Record<string, string>
}

// Request types
export interface AddSkillRequest {
  skillName: string
}

export interface UpdateSkillStatusRequest {
  status: SkillStatus
}

export interface SetsecretsRequest {
  envValues: Record<string, string>
}

// Success response
export interface SkillSuccessResponse {
  success: boolean
  message?: string
}

// Skill reference in Ghost spec
export interface GhostSkillRef {
  skillRef: string
  status: SkillStatus
}
