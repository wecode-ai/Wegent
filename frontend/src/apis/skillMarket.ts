// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Skill Market API - Client-side interface for skill market operations
 *
 * This module provides a simple API for searching and downloading skills
 * from the skill market. All requests are proxied through Next.js API routes
 * which handle the actual communication with the skill market provider.
 *
 * The server-side routes dynamically load the appropriate skill market
 * provider if available.
 */

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
  /** User making the request */
  user?: string
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
  /** Unique skill identifier */
  skillKey: string
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
}

/**
 * Check if a skill market provider is available
 *
 * @returns true if a skill market provider is available, false otherwise
 */
export async function checkSkillMarketAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/api/skill-market/available', {
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      return false
    }

    const data = await response.json()
    return data.available === true
  } catch {
    return false
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
  if (params.user) {
    queryParams.append('user', params.user)
  }

  const url = `/api/skill-market/search?${queryParams.toString()}`

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(
      errorData.error || errorData.message || `HTTP ${response.status}: Failed to search skills`
    )
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
 * @param user Optional user identifier
 * @returns Skill file as Blob
 * @throws Error if the request fails or no provider is available
 */
export async function downloadSkill(skillKey: string, user?: string): Promise<Blob> {
  // Build query parameters
  const queryParams = new URLSearchParams()
  if (user) {
    queryParams.append('user', user)
  }

  const url = `/api/skill-market/download/${encodeURIComponent(skillKey)}?${queryParams.toString()}`

  const response = await fetch(url, {
    headers: {
      Accept: 'application/octet-stream',
    },
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(
      errorData.error || errorData.message || `HTTP ${response.status}: Failed to download skill`
    )
  }

  return response.blob()
}

/**
 * Map raw skill data to MarketSkill interface
 */
function mapSkill(skill: unknown): MarketSkill {
  const s = skill as Record<string, unknown>
  return {
    skillKey: String(s.skillKey || ''),
    name: String(s.name || ''),
    description: String(s.description || ''),
    author: String(s.author || ''),
    visibility: String(s.visibility || 'public'),
    tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
    version: String(s.version || ''),
    downloadCount: Number(s.downloadCount || 0),
    createdAt: String(s.createdAt || ''),
  }
}
