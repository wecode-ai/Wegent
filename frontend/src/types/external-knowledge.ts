// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type ExternalKnowledgeProvider = string

export type ExternalKnowledgeScope = 'all' | 'personal' | 'organization' | (string & {})

export type ExternalNodeType = 'folder' | 'document' | (string & {})

export type ExternalPreviewMode = 'iframe' | 'new_tab'

export interface ExternalKnowledgeBase {
  provider: ExternalKnowledgeProvider
  knowledge_base_id: string
  knowledge_base_name: string
  description?: string | null
  scope?: ExternalKnowledgeScope | string | null
  owner_id?: string | null
  employee_id?: string | null
  owner_name?: string | null
  document_count?: number | null
  created_at?: string | null
  updated_at?: string | null
}

export interface ExternalKnowledgeBaseListResponse {
  items: ExternalKnowledgeBase[]
  total?: number
  limit?: number
  offset?: number
  has_more?: boolean
  warnings?: string[]
}

export interface ExternalKnowledgeBaseListParams {
  scope?: ExternalKnowledgeScope
  query?: string
  limit?: number
  offset?: number
}

export interface ExternalKbNode {
  node_id: string
  raw_id?: string | null
  name: string
  node_type: ExternalNodeType
  parent_id?: string | null
  has_children?: boolean | null
  children?: ExternalKbNode[] | null
  owner_id?: string | null
  employee_id?: string | null
  owner_name?: string | null
  previewable?: boolean | null
  content_readable?: boolean | null
  downloadable?: boolean | null
  mime_type?: string | null
  source_type?: string | null
  index_status?: string | null
  file_extension?: string | null
  file_size?: number | null
  browser_open_url?: string | null
  preview?: ExternalKnowledgePreview | null
}

export interface ExternalKbNodeListResponse {
  items: ExternalKbNode[]
  total?: number
  limit?: number
  offset?: number
  has_more?: boolean
  warnings?: string[]
}

export interface ExternalKbNodeListParams {
  folder_id?: string | null
  recursive?: boolean
  limit?: number
  offset?: number
}

export interface ExternalKnowledgePreview {
  url: string
  preview_mode: ExternalPreviewMode
}

export interface ExternalKnowledgeHealth {
  provider: ExternalKnowledgeProvider
  status?: string
  healthy?: boolean
  warnings?: string[]
}

export interface ExternalSearchRecord {
  content: string
  title?: string | null
  score?: number | null
  knowledge_base_id: string
  knowledge_base_name?: string | null
  document_id?: string | null
}

export interface ExternalSearchResult {
  query: string
  total: number
  records: ExternalSearchRecord[]
  searched_knowledge_base_ids?: string[]
  ignored_knowledge_base_ids?: string[]
  warnings?: string[]
}
