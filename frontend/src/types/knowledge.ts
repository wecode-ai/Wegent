// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base and document related types
 */

export type DocumentStatus = 'enabled' | 'disabled'

export type DocumentSourceType = 'file' | 'text' | 'table'

export type KnowledgeResourceScope = 'personal' | 'group' | 'all'

// Retrieval Config types
export interface RetrievalConfig {
  retriever_name: string
  retriever_namespace: string
  embedding_config: {
    model_name: string
    model_namespace: string
  }
  retrieval_mode?: 'vector' | 'keyword' | 'hybrid'
  top_k?: number
  score_threshold?: number
  hybrid_weights?: {
    vector_weight: number
    keyword_weight: number
  }
}

// Splitter Config types
export type SplitterType = 'sentence' | 'semantic'

// Base splitter config
export interface BaseSplitterConfig {
  type: SplitterType
}

// Sentence splitter config
export interface SentenceSplitterConfig extends BaseSplitterConfig {
  type: 'sentence'
  separator?: string
  chunk_size?: number
  chunk_overlap?: number
}

// Semantic splitter config
export interface SemanticSplitterConfig extends BaseSplitterConfig {
  type: 'semantic'
  buffer_size?: number // 1-10, default 1
  breakpoint_percentile_threshold?: number // 50-100, default 95
}

// Union type for splitter config
export type SplitterConfig = SentenceSplitterConfig | SemanticSplitterConfig

// Summary Model Reference types
export interface SummaryModelRef {
  name: string
  namespace: string
  type: 'public' | 'user' | 'group'
}

// Knowledge Base types
export interface KnowledgeBase {
  id: number
  name: string
  description: string | null
  user_id: number
  namespace: string
  document_count: number
  is_active: boolean
  retrieval_config?: RetrievalConfig
  summary_enabled: boolean
  summary_model_ref?: SummaryModelRef | null
  summary?: KnowledgeBaseSummary | null
  created_at: string
  updated_at: string
}

export interface KnowledgeBaseCreate {
  name: string
  description?: string
  namespace?: string
  retrieval_config?: Partial<RetrievalConfig>
  summary_enabled?: boolean
  summary_model_ref?: SummaryModelRef | null
}

export interface RetrievalConfigUpdate {
  retrieval_mode?: 'vector' | 'keyword' | 'hybrid'
  top_k?: number
  score_threshold?: number
  hybrid_weights?: {
    vector_weight: number
    keyword_weight: number
  }
}

export interface KnowledgeBaseUpdate {
  name?: string
  description?: string
  retrieval_config?: RetrievalConfigUpdate
  summary_enabled?: boolean
  summary_model_ref?: SummaryModelRef | null
}

export interface KnowledgeBaseListResponse {
  total: number
  items: KnowledgeBase[]
}

// Knowledge Document types
export interface KnowledgeDocument {
  id: number
  kind_id: number
  attachment_id: number | null
  name: string
  file_extension: string
  file_size: number
  status: DocumentStatus
  user_id: number
  is_active: boolean
  splitter_config?: SplitterConfig
  source_type: DocumentSourceType
  source_config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface KnowledgeDocumentCreate {
  attachment_id?: number
  name: string
  file_extension: string
  file_size: number
  splitter_config?: Partial<SplitterConfig>
  source_type?: DocumentSourceType
  source_config?: Record<string, unknown>
}

export interface KnowledgeDocumentUpdate {
  name?: string
  status?: DocumentStatus
  splitter_config?: Partial<SplitterConfig>
}

export interface KnowledgeDocumentListResponse {
  total: number
  items: KnowledgeDocument[]
}

// Accessible Knowledge types (for AI integration)
export interface AccessibleKnowledgeBase {
  id: number
  name: string
  description: string | null
  document_count: number
  updated_at: string
}

export interface TeamKnowledgeGroup {
  group_name: string
  group_display_name: string | null
  knowledge_bases: AccessibleKnowledgeBase[]
}

export interface AccessibleKnowledgeResponse {
  personal: AccessibleKnowledgeBase[]
  team: TeamKnowledgeGroup[]
}

// Table URL Validation types
export interface TableUrlValidationRequest {
  url: string
}

export interface TableUrlValidationResponse {
  valid: boolean
  provider?: string
  base_id?: string
  sheet_id?: string
  error_code?:
    | 'INVALID_URL_FORMAT'
    | 'UNSUPPORTED_PROVIDER'
    | 'PARSE_FAILED'
    | 'MISSING_DINGTALK_ID'
    | 'TABLE_ACCESS_FAILED'
    | 'TABLE_ACCESS_FAILED_LINKED_TABLE'
  error_message?: string
}

// Document Summary types
export interface DocumentSummary {
  short_summary?: string
  long_summary?: string
  topics?: string[]
  meta_info?: {
    author?: string
    source?: string
    type?: string
  }
  status?: 'pending' | 'generating' | 'completed' | 'failed'
  task_id?: number
  error?: string
  updated_at?: string
}

// Knowledge Base Summary types
export interface KnowledgeBaseSummary {
  short_summary?: string
  long_summary?: string
  topics?: string[]
  meta_info?: {
    document_count?: number
    last_updated?: string
  }
  status?: 'pending' | 'generating' | 'completed' | 'failed'
  task_id?: number
  error?: string
  updated_at?: string
  last_summary_doc_count?: number
}

export interface KnowledgeBaseSummaryResponse {
  kb_id: number
  summary: KnowledgeBaseSummary | null
}

// Document Detail types
export interface DocumentDetailResponse {
  document_id: number
  content?: string
  content_length?: number
  truncated?: boolean
  summary?: DocumentSummary | null
}
