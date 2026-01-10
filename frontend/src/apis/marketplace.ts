// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/lib/api-client'
import type {
  CategoryListResponse,
  InstallMode,
  InstallTeamResponse,
  InstalledTeamListResponse,
  MarketplaceTeamDetail,
  MarketplaceTeamListResponse,
  UninstallTeamResponse,
} from '@/types/marketplace'

// ==================== Public APIs ====================

/**
 * Get marketplace teams list with pagination, search, and filtering
 */
export async function fetchMarketplaceTeams(params?: {
  page?: number
  limit?: number
  search?: string
  category?: string
}): Promise<MarketplaceTeamListResponse> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.search) searchParams.set('search', params.search)
  if (params?.category) searchParams.set('category', params.category)

  const queryString = searchParams.toString()
  const url = `/marketplace/teams${queryString ? `?${queryString}` : ''}`

  const response = await apiClient.get<MarketplaceTeamListResponse>(url)
  return response.data
}

/**
 * Get marketplace team detail
 */
export async function fetchMarketplaceTeamDetail(marketplaceId: number): Promise<MarketplaceTeamDetail> {
  const response = await apiClient.get<MarketplaceTeamDetail>(`/marketplace/teams/${marketplaceId}`)
  return response.data
}

/**
 * Get all categories with their team counts
 */
export async function fetchMarketplaceCategories(): Promise<CategoryListResponse> {
  const response = await apiClient.get<CategoryListResponse>('/marketplace/categories')
  return response.data
}

// ==================== Installation APIs ====================

/**
 * Install a marketplace team
 */
export async function installMarketplaceTeam(
  marketplaceId: number,
  mode: InstallMode
): Promise<InstallTeamResponse> {
  const response = await apiClient.post<InstallTeamResponse>(
    `/marketplace/teams/${marketplaceId}/install`,
    { mode }
  )
  return response.data
}

/**
 * Uninstall a marketplace team
 */
export async function uninstallMarketplaceTeam(marketplaceId: number): Promise<UninstallTeamResponse> {
  const response = await apiClient.delete<UninstallTeamResponse>(
    `/marketplace/teams/${marketplaceId}/uninstall`
  )
  return response.data
}

/**
 * Get user's installed marketplace teams
 */
export async function fetchInstalledTeams(): Promise<InstalledTeamListResponse> {
  const response = await apiClient.get<InstalledTeamListResponse>('/marketplace/installed')
  return response.data
}

// ==================== Admin APIs ====================

/**
 * Publish a team to marketplace (admin only)
 */
export async function publishTeamToMarketplace(data: {
  team_id: number
  category: string
  description?: string
  icon?: string
  allow_reference?: boolean
  allow_copy?: boolean
}): Promise<{ success: boolean; marketplace_id: number; team_id: number }> {
  const response = await apiClient.post('/marketplace/admin/teams', data)
  return response.data
}

/**
 * Update marketplace team info (admin only)
 */
export async function updateMarketplaceTeam(
  marketplaceId: number,
  data: {
    category?: string
    description?: string
    icon?: string
    allow_reference?: boolean
    allow_copy?: boolean
    is_active?: boolean
  }
): Promise<{ success: boolean; marketplace_id: number }> {
  const response = await apiClient.put(`/marketplace/admin/teams/${marketplaceId}`, data)
  return response.data
}

/**
 * Unpublish marketplace team (admin only)
 */
export async function unpublishMarketplaceTeam(
  marketplaceId: number
): Promise<{ success: boolean; message: string }> {
  const response = await apiClient.delete(`/marketplace/admin/teams/${marketplaceId}`)
  return response.data
}

/**
 * Get all marketplace teams for admin (admin only)
 */
export async function fetchAdminMarketplaceTeams(params?: {
  page?: number
  limit?: number
  include_inactive?: boolean
}): Promise<{ total: number; items: MarketplaceTeamDetail[] }> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.include_inactive !== undefined)
    searchParams.set('include_inactive', String(params.include_inactive))

  const queryString = searchParams.toString()
  const url = `/marketplace/admin/teams${queryString ? `?${queryString}` : ''}`

  const response = await apiClient.get(url)
  return response.data
}
