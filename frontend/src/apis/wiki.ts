// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { WikiProjectsResponse, WikiGenerationsResponse, WikiGenerationDetail } from '@/types/wiki'
import { apiClient } from './client'

/**
 /**
  * Wiki config response type
  */
export interface WikiConfigResponse {
  default_team_name: string
  default_team: {
    id: number
    name: string
    agent_type: string
  } | null
  default_user_id: number
  has_bound_model: boolean
  bound_model_name: string | null
  enabled: boolean
  default_language: string
}
/**
 * Get all Wiki projects
 * @param page Page number, defaults to 1
 * @param limit Items per page, defaults to 100
 * @returns Wiki projects list response
 */
export async function fetchWikiProjects(page = 1, limit = 100): Promise<WikiProjectsResponse> {
  try {
    const queryParams = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
    })

    return await apiClient.get(`/wiki/projects?${queryParams.toString()}`)
  } catch (error) {
    console.error('Error fetching wiki projects:', error)
    throw error
  }
}
/**
 * Get Wiki generation records list
 * @param projectId Project ID
 * @param page Page number, defaults to 1
 * @param limit Items per page, defaults to 10
 * @returns Wiki generations list response
 *
 * Note: The backend uses system-configured WIKI_DEFAULT_USER_ID to filter generations.
 * This ensures all users see the same wiki content managed by the system user.
 */
export async function fetchWikiGenerations(
  projectId: number,
  page = 1,
  limit = 10
): Promise<WikiGenerationsResponse> {
  try {
    const queryParams = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
      project_id: projectId.toString(),
    })

    return await apiClient.get(`/wiki/generations?${queryParams.toString()}`)
  } catch (error) {
    console.error('Error fetching wiki generations:', error)
    throw error
  }
}

/**
 * Get Wiki generation detail
 * @param generationId Generation record ID
 * @returns Wiki generation detail
 */
export async function fetchWikiGenerationDetail(
  generationId: number
): Promise<WikiGenerationDetail> {
  try {
    return await apiClient.get(`/wiki/generations/${generationId}`)
  } catch (error) {
    console.error('Error fetching wiki generation detail:', error)
    throw error
  }
}

/**
 * Get the latest completed Wiki generation record
 * @param projectId Project ID
 * @returns Latest completed Wiki generation record ID
 */
export async function fetchLatestCompletedWikiGeneration(
  projectId: number
): Promise<number | null> {
  try {
    const generations = await fetchWikiGenerations(projectId)

    // Check if API response is valid
    if (!generations || !generations.items || !Array.isArray(generations.items)) {
      console.error('Invalid API response from fetchWikiGenerations:', generations)
      return null
    }

    // Sort by update time and find the latest completed record
    const completedGenerations = generations.items
      .filter(gen => gen && gen.status === 'COMPLETED')
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())

    if (completedGenerations.length > 0) {
      return completedGenerations[0].id
    }

    // If no completed records, but other records exist, return the first record ID (for testing)
    if (generations.items.length > 0) {
      console.log('No completed generations found, using first available:', generations.items[0].id)
      return generations.items[0].id
    }

    return null
  } catch (error) {
    console.error('Error fetching latest completed wiki generation:', error)
    // Return null instead of throwing error for better error handling
    return null
  }
}

/**
 * Create Wiki generation
 * @param data Create Wiki generation data
 * @returns Created Wiki generation
 */
export async function createWikiGeneration(data: Record<string, unknown>): Promise<unknown> {
  try {
    return await apiClient.post('/wiki/generations', data)
  } catch (error) {
    console.error('Error creating wiki generation:', error)
    // If it's an Error object, extract the error message
    if (error instanceof Error) {
      throw new Error(error.message)
    }
    // Otherwise, throw the error directly
    throw error
  }
}

/**
 * Cancel Wiki generation
 * @param generationId Generation record ID
 * @returns Cancelled Wiki generation
 */
export async function cancelWikiGeneration(generationId: number): Promise<unknown> {
  try {
    return await apiClient.post(`/wiki/generations/${generationId}/cancel`)
  } catch (error) {
    console.error('Error cancelling wiki generation:', error)
    // If it's an Error object, extract the error message
    if (error instanceof Error) {
      throw new Error(error.message)
    }
    // Otherwise, throw the error directly
    throw error
  }
}

/**
 * Get Wiki configuration including default team info
 * @returns Wiki configuration
 */
export async function fetchWikiConfig(): Promise<WikiConfigResponse> {
  try {
    return await apiClient.get('/wiki/config')
  } catch (error) {
    console.error('Error fetching wiki config:', error)
    throw error
  }
}
