// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill Market API - Client-side interface for skill market operations
 *
 * This module provides a simple API for searching and downloading skills
 * from the skill market. Requests are sent directly to the backend Python
 * service which handles communication with the skill market provider.
 */

import { getToken } from './user'
import { getApiBaseUrl } from '@/lib/runtime-config'

// Use dynamic API base URL from runtime config
const getApiUrl = () => getApiBaseUrl()

/**
 * Parameters for searching skills
 */
export interface SearchSkillsParams {
  /** Keyword search */
  keyword?: string
  /** Tag filter */
  tags?: string
  /** Page number */
  page?: number
  /** Page size */
  pageSize?: number
}

/**
 * Result of searching skills
 */
export interface SearchSkillsResult {
  /** Total number of skills */
  total: number
  /** Current page */
  page: number
  /** Page size */
  pageSize: number
  /** List of skills */
  skills: MarketSkill[]
}

/**
 * Skill information from a market
 */
export interface MarketSkill {
  /** Unique skill identifier (provider-specific format) */
  skillKey: string
  /** Original skill key for installation (provider-agnostic) */
  originalSkillKey: string
  /** Skill name */
  name: string
  /** Skill description */
  description: string
  /** Author name */
  author: string
  /** Visibility (public/private) */
  visibility: string
  /** Tags */
  tags: string[]
  /** Version */
  version: string
  /** Download count */
  downloadCount: number
  /** Creation time */
  createdAt: string
  /** Whether the current user has download permission */
  hasDownloadPermission: boolean
  /** URL for requesting permission or viewing skill details (provider-generated) */
  permissionUrl: string
}
/**
 * Skill market availability response
 */
export interface SkillMarketAvailability {
  /** Whether a skill market provider is available */
  available: boolean
  /** Market name for display */
  marketName?: string
  /** Market URL for navigation */
  marketUrl?: string
}

/**
 * Check if a skill market provider is available
 *
 * @returns Skill market availability info including market name and URL
 */
export async function checkSkillMarketAvailable(): Promise<SkillMarketAvailability> {
  try {
    const token = getToken()
    if (!token) return { available: false }

    const url = `${getApiUrl()}/skill-market/available`
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })

    if (!response.ok) {
      return { available: false }
    }

    const data = await response.json()
    return {
      available: data.available === true,
      marketName: data.market_name || undefined,
      marketUrl: data.market_url || undefined,
    }
  } catch {
    return { available: false }
  }
}

/**
 * Search skills from the skill market
 *
 * @param params Search parameters
 * @returns Search result with skills list
 * @throws Error if the request fails or no provider is available
 */
export async function searchSkills(params: SearchSkillsParams): Promise<SearchSkillsResult> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  // Build query parameters
  const queryParams = new URLSearchParams()

  if (params.keyword) {
    queryParams.append('keyword', params.keyword)
  }
  if (params.tags) {
    queryParams.append('tags', params.tags)
  }
  if (params.page) {
    queryParams.append('page', params.page.toString())
  }
  if (params.pageSize) {
    queryParams.append('pageSize', params.pageSize.toString())
  }

  const url = `${getApiUrl()}/skill-market/search?${queryParams.toString()}`

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
    // FastAPI wraps errors in a detail object, check for it first
    const detail = errorData.detail
    const errorMessage =
      detail?.error ||
      detail?.message ||
      errorData.error ||
      errorData.message ||
      `HTTP ${response.status}: Failed to search skills`
    throw new Error(errorMessage)
  }

  const data = await response.json()

  return {
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
    skills: data.skills.map((skill: unknown) => mapSkill(skill)),
  }
}

/**
 * Download a skill from the skill market
 *
 * @param skillKey Unique skill identifier
 * @returns Skill file as Blob
 * @throws Error if the request fails or no provider is available
 */
export async function downloadSkill(skillKey: string): Promise<Blob> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/skill-market/download/${encodeURIComponent(skillKey)}`

  const response = await fetch(url, {
    headers: {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
    // FastAPI wraps errors in a detail object, check for it first
    const detail = errorData.detail
    const errorMessage =
      detail?.error ||
      detail?.message ||
      errorData.error ||
      errorData.message ||
      `HTTP ${response.status}: Failed to download skill`
    throw new Error(errorMessage)
  }

  return response.blob()
}

/**
 * Map raw skill data to MarketSkill interface
 */
function mapSkill(skill: unknown): MarketSkill {
  const s = skill as Record<string, unknown>
  const skillKey = String(s.skillKey || '')
  return {
    skillKey,
    originalSkillKey: String(s.originalSkillKey || skillKey),
    name: String(s.name || ''),
    description: String(s.description || ''),
    author: String(s.author || ''),
    visibility: String(s.visibility || 'public'),
    tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
    version: String(s.version || ''),
    downloadCount: Number(s.downloadCount || 0),
    createdAt: String(s.createdAt || ''),
    hasDownloadPermission: s.hasDownloadPermission === true,
    permissionUrl: String(s.permissionUrl || ''),
  }
}
