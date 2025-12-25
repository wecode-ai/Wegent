// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from './client'
import type {
  Tool,
  ToolCreate,
  ToolUpdate,
  ToolListResponse,
  ToolMarketListResponse,
  ToolMarketItem,
  ToolCategoryResponse,
  GhostToolDetail,
  ToolSecretConfig,
  ToolStatus,
} from '@/types/tool'

// ============================================================================
// Tool Market APIs
// ============================================================================

/**
 * List public tools in the market
 */
export async function getMarketTools(params?: {
  category?: string
  search?: string
  skip?: number
  limit?: number
}): Promise<ToolMarketListResponse> {
  const searchParams = new URLSearchParams()
  if (params?.category) searchParams.append('category', params.category)
  if (params?.search) searchParams.append('search', params.search)
  if (params?.skip !== undefined) searchParams.append('skip', String(params.skip))
  if (params?.limit !== undefined) searchParams.append('limit', String(params.limit))

  const query = searchParams.toString()
  return apiClient.get<ToolMarketListResponse>(`/tools/market${query ? `?${query}` : ''}`)
}

/**
 * Get a specific tool from the market
 */
export async function getMarketTool(toolId: number): Promise<ToolMarketItem> {
  return apiClient.get<ToolMarketItem>(`/tools/market/${toolId}`)
}

/**
 * Get all tool categories
 */
export async function getToolCategories(): Promise<ToolCategoryResponse> {
  return apiClient.get<ToolCategoryResponse>('/tools/categories')
}

// ============================================================================
// Tool CRUD APIs
// ============================================================================

/**
 * List tools for current user
 */
export async function getTools(params?: {
  visibility?: string
  category?: string
  tool_type?: string
  skip?: number
  limit?: number
}): Promise<ToolListResponse> {
  const searchParams = new URLSearchParams()
  if (params?.visibility) searchParams.append('visibility', params.visibility)
  if (params?.category) searchParams.append('category', params.category)
  if (params?.tool_type) searchParams.append('tool_type', params.tool_type)
  if (params?.skip !== undefined) searchParams.append('skip', String(params.skip))
  if (params?.limit !== undefined) searchParams.append('limit', String(params.limit))

  const query = searchParams.toString()
  return apiClient.get<ToolListResponse>(`/tools${query ? `?${query}` : ''}`)
}

/**
 * Create a new tool
 */
export async function createTool(tool: ToolCreate): Promise<Tool> {
  return apiClient.post<Tool>('/tools', tool)
}

/**
 * Get a specific tool
 */
export async function getTool(toolId: number): Promise<Tool> {
  return apiClient.get<Tool>(`/tools/${toolId}`)
}

/**
 * Update a tool
 */
export async function updateTool(toolId: number, tool: ToolUpdate): Promise<Tool> {
  return apiClient.put<Tool>(`/tools/${toolId}`, tool)
}

/**
 * Delete a tool
 */
export async function deleteTool(toolId: number): Promise<void> {
  return apiClient.delete<void>(`/tools/${toolId}`)
}

// ============================================================================
// Ghost Tool APIs
// ============================================================================

/**
 * List all tools in a Ghost
 */
export async function getGhostTools(ghostId: number): Promise<GhostToolDetail[]> {
  return apiClient.get<GhostToolDetail[]>(`/tools/ghosts/${ghostId}/tools`)
}

/**
 * Add a tool to a Ghost
 */
export async function addToolToGhost(
  ghostId: number,
  toolName: string
): Promise<{ toolRef: string; status: ToolStatus }> {
  return apiClient.post<{ toolRef: string; status: ToolStatus }>(
    `/tools/ghosts/${ghostId}/tools?tool_name=${encodeURIComponent(toolName)}`
  )
}

/**
 * Remove a tool from a Ghost
 */
export async function removeToolFromGhost(
  ghostId: number,
  toolName: string
): Promise<{ message: string }> {
  return apiClient.delete<{ message: string }>(
    `/tools/ghosts/${ghostId}/tools/${encodeURIComponent(toolName)}`
  )
}

/**
 * Update tool status in a Ghost
 */
export async function updateToolStatusInGhost(
  ghostId: number,
  toolName: string,
  status: ToolStatus
): Promise<{ toolRef: string; status: ToolStatus }> {
  return apiClient.put<{ toolRef: string; status: ToolStatus }>(
    `/tools/ghosts/${ghostId}/tools/${encodeURIComponent(toolName)}?status=${status}`
  )
}

// ============================================================================
// Tool Secret APIs
// ============================================================================

/**
 * Get secret configuration for a tool in a Ghost (masked values)
 */
export async function getToolsecrets(
  ghostId: number,
  toolName: string
): Promise<ToolSecretConfig> {
  return apiClient.get<ToolSecretConfig>(
    `/tools/ghosts/${ghostId}/tools/${encodeURIComponent(toolName)}/secrets`
  )
}

/**
 * Set secret configuration for a tool in a Ghost
 */
export async function setToolsecrets(
  ghostId: number,
  toolName: string,
  env: Record<string, string>
): Promise<{ message: string }> {
  return apiClient.put<{ message: string }>(
    `/tools/ghosts/${ghostId}/tools/${encodeURIComponent(toolName)}/secrets`,
    { env }
  )
}
