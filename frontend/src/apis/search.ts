// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

/**
 * Search content types
 */
export type SearchType = 'chat' | 'code' | 'knowledge' | 'teams'

/**
 * Sort types for search results
 */
export type SortType = 'relevance' | 'date' | 'date_asc'

/**
 * Search highlight information
 */
export interface SearchHighlight {
  title?: string[]
  content?: string[]
}

/**
 * Single search result item
 */
export interface SearchResultItem {
  id: string
  type: SearchType
  title: string
  snippet: string
  highlight: SearchHighlight
  created_at: string | null
  updated_at: string | null
  metadata: Record<string, unknown>
}

/**
 * Search facets - result counts by type
 */
export interface SearchFacets {
  chat: number
  code: number
  knowledge: number
  teams: number
}

/**
 * Unified search response
 */
export interface SearchResponse {
  total: number
  items: SearchResultItem[]
  facets: SearchFacets
}

/**
 * Search parameters
 */
export interface SearchParams {
  q: string
  types?: SearchType[]
  sort?: SortType
  date_from?: string
  date_to?: string
  page?: number
  limit?: number
}

/**
 * Search API functions
 */
export const searchApis = {
  /**
   * Unified search across all content types
   */
  search: async (params: SearchParams): Promise<SearchResponse> => {
    const query = new URLSearchParams()
    query.append('q', params.q)

    if (params.types && params.types.length > 0) {
      query.append('types', params.types.join(','))
    }
    if (params.sort) {
      query.append('sort', params.sort)
    }
    if (params.date_from) {
      query.append('date_from', params.date_from)
    }
    if (params.date_to) {
      query.append('date_to', params.date_to)
    }
    if (params.page) {
      query.append('page', params.page.toString())
    }
    if (params.limit) {
      query.append('limit', params.limit.toString())
    }

    return apiClient.get(`/search?${query}`)
  },
}

export default searchApis
