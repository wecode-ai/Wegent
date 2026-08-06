// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { WikiProjectsResponse, WikiGenerationsResponse } from '@/types/wiki'
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
 * The project is required: the backend used to list across every project, narrowed
 * only by WIKI_DEFAULT_USER_ID — a deployment setting rather than a claim about the
 * caller — which let any signed-in user read anybody's generations. It now answers
 * for one project, and only for a caller who may read that project's repository.
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
