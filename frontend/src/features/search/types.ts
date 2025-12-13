// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type SearchType = 'chat' | 'code' | 'knowledge' | 'teams'
export type SortType = 'relevance' | 'date' | 'date_asc'
export type DateRangeType = 'all' | '1d' | '7d' | '30d' | 'custom'

export interface SearchHighlight {
  title?: string[]
  content?: string[]
}

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

export interface SearchFacets {
  chat: number
  code: number
  knowledge: number
  teams: number
}

export interface SearchResponse {
  total: number
  items: SearchResultItem[]
  facets: SearchFacets
}

export interface SearchState {
  query: string
  types: SearchType[]
  sort: SortType
  dateRange: DateRangeType
  dateFrom?: string
  dateTo?: string
  page: number
}
