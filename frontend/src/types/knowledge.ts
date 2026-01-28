// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base and document related types
 */

export type DocumentStatus = 'enabled' | 'disabled'

export type DocumentSourceType = 'file' | 'text' | 'table' | 'web'

export type KnowledgeResourceScope = 'personal' | 'group' | 'all' | 'external' | 'organization'

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

// Knowledge Base Type
// - notebook: Three-column layout with chat area and document panel (new style)
// - classic: Document list only without chat functionality (legacy style)
export type KnowledgeBaseType = 'notebook' | 'classic'

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
  /** Knowledge base display type: 'notebook' (three-column with chat) or 'classic' (document list only) */
  kb_type?: KnowledgeBaseType
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
  /** Knowledge base display type: 'notebook' (three-column with chat) or 'classic' (document list only) */
  kb_type?: KnowledgeBaseType
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

// Web Scraper types
export interface WebScrapeRequest {
  url: string
}

export interface WebScrapeResponse {
  title?: string
  content: string
  url: string
  scraped_at: string
  content_length: number
  description?: string
  success: boolean
  error_code?:
    | 'INVALID_URL_FORMAT'
    | 'FETCH_FAILED'
    | 'FETCH_TIMEOUT'
    | 'PARSE_FAILED'
    | 'EMPTY_CONTENT'
    | 'AUTH_REQUIRED'
    | 'SSRF_BLOCKED'
    | 'CONTENT_TOO_LARGE'
    | 'NOT_HTML'
  error_message?: string
}

// ============== Permission Management Types ==============

export type PermissionType = 'read' | 'download' | 'write' | 'manage'

export type PermissionSource =
  | 'owner'
  | 'group_role'
  | 'explicit_grant'
  | 'organization_member'
  | 'system_admin'
  | 'none'

// Share info for share page
export interface KnowledgeShareInfoResponse {
  kb_id: number
  name: string
  description: string | null
  namespace: string
  kb_type: string | null
  owner_user_id: number
  owner_username: string
  has_permission: boolean
  permission_type: PermissionType | null
  permission_source: PermissionSource
}

// Permission creation
export interface PermissionCreate {
  user_ids: number[]
  permission_type: PermissionType
}

// Permission update
export interface PermissionUpdate {
  permission_type: PermissionType
}

// Permission record
export interface PermissionResponse {
  id: number
  user_id: number
  username: string
  permission_type: PermissionType
  granted_by_user_id: number
  granted_by_username: string
  granted_at: string
}

// Permission list
export interface PermissionListResponse {
  total: number
  items: PermissionResponse[]
}

// Batch permission result
export interface PermissionBatchResult {
  success_count: number
  skipped_count: number
  skipped_user_ids: number[]
}

// Current user's permission
export interface MyPermissionResponse {
  has_permission: boolean
  permission_type: PermissionType | null
  permission_source: PermissionSource
}

// ============== Permission Request Types ==============

export type PermissionRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'

// Permission request creation
export interface PermissionRequestCreate {
  kind_id: number
  request_reason?: string
  requested_permission_type?: 'read' | 'download' | 'write'
}

// Permission request processing
export interface PermissionRequestProcess {
  action: 'approve' | 'reject'
  response_message?: string
  granted_permission_type?: PermissionType
}

// Permission request response
export interface PermissionRequestResponse {
  id: number
  kind_id: number
  resource_type: string
  applicant_user_id: number
  applicant_username: string
  requested_permission_type: string
  request_reason: string | null
  status: PermissionRequestStatus
  processed_by_user_id: number | null
  processed_by_username: string | null
  processed_at: string | null
  response_message: string | null
  created_at: string
  updated_at: string
  // Additional info for display
  kb_name: string | null
  kb_description: string | null
  kb_owner_username: string | null
}

// Permission request list response
export interface PermissionRequestListResponse {
  total: number
  items: PermissionRequestResponse[]
}

// Pending request count response
export interface PendingRequestCountResponse {
  count: number
}

// My requests response
export interface MyRequestsResponse {
  total: number
  items: PermissionRequestResponse[]
}

// Check pending request response
export interface PermissionRequestCheckResponse {
  has_pending_request: boolean
  pending_request: PermissionRequestResponse | null
}
