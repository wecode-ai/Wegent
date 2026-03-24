// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base and document related types
 */

// Import BaseRole and related utilities from base-role module
import type { BaseRole } from './base-role'

// Re-export MemberRole as backward compatible alias
export type MemberRole = BaseRole

export type DocumentStatus = 'enabled' | 'disabled'

export type DocumentSourceType = 'file' | 'text' | 'table' | 'web'

export type KnowledgeResourceScope = 'personal' | 'organization' | 'group' | 'all'

// Retrieval Config types
export interface RetrievalConfig {
  retriever_name?: string
  retriever_namespace?: string
  embedding_config?: {
    model_name?: string
    model_namespace?: string
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
export type SplitterType = 'sentence' | 'semantic' | 'smart'

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

// Smart splitter config (file-type aware)
export interface SmartSplitterConfig extends BaseSplitterConfig {
  type: 'smart'
  chunk_size?: number // 128-8192, default 1024
  chunk_overlap?: number // 0-2048, default 50
  file_extension?: string // .md, .txt, .pdf, .doc, .docx
  subtype?: string // markdown_sentence, sentence, recursive_character
}

// Union type for splitter config
export type SplitterConfig = SentenceSplitterConfig | SemanticSplitterConfig | SmartSplitterConfig

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
  /** Guided questions list (max 3) for notebook mode quick user interaction */
  guided_questions?: string[]
  /** Maximum number of knowledge base tool calls allowed per conversation */
  max_calls_per_conversation: number
  /** Number of calls exempt from token checking (must be < max_calls_per_conversation) */
  exempt_calls_before_check: number
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
  /** Guided questions list (max 3) for notebook mode quick user interaction */
  guided_questions?: string[]
  /** Maximum number of knowledge base tool calls allowed per conversation */
  max_calls_per_conversation?: number
  /** Number of calls exempt from token checking (must be < max_calls_per_conversation) */
  exempt_calls_before_check?: number
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
  /** Guided questions list (max 3) for notebook mode quick user interaction */
  guided_questions?: string[]
  /** Maximum number of knowledge base tool calls allowed per conversation */
  max_calls_per_conversation?: number
  /** Number of calls exempt from token checking (must be < max_calls_per_conversation) */
  exempt_calls_before_check?: number
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

// Chunk types
export interface ChunkItem {
  index: number
  content: string
  token_count: number
  start_position: number
  end_position: number
}

export interface ChunkResponse {
  index: number
  content: string
  token_count: number
  document_name: string
  document_id: number
  kb_id: number
}

export interface ChunkListResponse {
  total: number
  page: number
  page_size: number
  items: ChunkItem[]
  splitter_type?: string
  splitter_subtype?: string
}

// ============== Permission Types ==============

export type PermissionStatus = 'pending' | 'approved' | 'rejected'
export type ReviewAction = 'approve' | 'reject'

// Note: ROLE_DISPLAY_NAMES, ROLE_DISPLAY_NAMES_EN, and ROLE_HIERARCHY
// are now defined in ./base-role.ts and should be imported from there

// Permission Apply types
export interface PermissionApplyRequest {
  role: MemberRole
}

export interface PermissionApplyResponse {
  id: number
  knowledge_base_id: number
  role: MemberRole
  status: PermissionStatus
  requested_at: string
  message: string
}

// Permission Review types
export interface PermissionReviewRequest {
  action: ReviewAction
  role?: MemberRole
}

export interface PermissionReviewResponse {
  id: number
  user_id: number
  role: MemberRole | null
  status: PermissionStatus
  reviewed_at: string
  message: string
}

// Permission Add/Update types
export interface PermissionAddRequest {
  user_name: string
  role: MemberRole
}

export interface PermissionUpdateRequest {
  role: MemberRole
}

// Batch permission add types
export interface BatchPermissionAddRequest {
  members: { user_id: number; role: MemberRole }[]
}

export interface BatchPermissionAddResponse {
  succeeded: PermissionResponse[]
  failed: { user_id: number; error: string }[]
}

// Permission User Info types
export interface PermissionUserInfo {
  id: number
  user_id: number
  username: string
  email?: string
  role: MemberRole
  requested_at: string
  reviewed_at?: string
  reviewed_by?: number
}

export interface PendingPermissionInfo {
  id: number
  user_id: number
  username: string
  email?: string
  role: MemberRole
  requested_at: string
}

// Approved permissions grouped by role
export interface ApprovedPermissionsByRole {
  Owner: PermissionUserInfo[]
  Maintainer: PermissionUserInfo[]
  Developer: PermissionUserInfo[]
  Reporter: PermissionUserInfo[]
  RestrictedAnalyst: PermissionUserInfo[]
}

export interface PermissionListResponse {
  pending: PendingPermissionInfo[]
  approved: ApprovedPermissionsByRole
}

// Current User Permission types
export interface PendingRequestInfo {
  id: number
  role: MemberRole
  requested_at: string
}

export interface MyPermissionResponse {
  has_access: boolean
  role: MemberRole | null
  is_creator: boolean
  pending_request: PendingRequestInfo | null
}

// Permission Response (for CRUD operations)
export interface PermissionResponse {
  id: number
  knowledge_base_id: number
  user_id: number
  role: MemberRole
  status: PermissionStatus
  requested_at: string
  reviewed_at?: string
  reviewed_by?: number
  created_at: string
  updated_at: string
}

// KB Share Info for share page
export interface KBShareInfo {
  id: number
  name: string
  description?: string
  namespace: string
  creator_id: number
  creator_name: string
  created_at?: string
  my_permission: MyPermissionResponse
}

// Public Knowledge Base Response (for anonymous access via share token)
export interface PublicKnowledgeBaseResponse {
  id: number
  name: string
  description?: string
  creator_id: number
  creator_name: string
  require_approval: boolean
  default_role: MemberRole
  is_expired: boolean
}

// Share Link types
export interface ShareLinkConfig {
  require_approval?: boolean
  default_role?: MemberRole
  expires_in_hours?: number
}

export interface ShareLinkResponse {
  id: number
  resource_type: string
  resource_id: number
  share_url: string
  share_token: string
  require_approval: boolean
  default_role: MemberRole
  expires_at?: string
  is_active: boolean
  created_by_user_id: number
  created_at: string
  updated_at: string
}

// Join by link types
export interface JoinByLinkRequest {
  share_token: string
  requested_role?: MemberRole
}

export interface JoinByLinkResponse {
  message: string
  status: 'pending' | 'approved' | 'rejected'
  member_id: number
  resource_type: string
  resource_id: number
  copied_resource_id?: number
}

// Personal Knowledge Base Group (for grouped display)
export interface PersonalKnowledgeBaseGroup {
  created_by_me: KnowledgeBase[]
  shared_with_me: KnowledgeBase[]
}

// ============== All Grouped Knowledge Types ==============

/** Group type for knowledge base categorization */
export type KnowledgeGroupType = 'personal' | 'personal-shared' | 'group' | 'organization'

/** Knowledge base with group info for all-grouped response */
export interface KnowledgeBaseWithGroupInfo {
  id: number
  name: string
  description: string | null
  kb_type: KnowledgeBaseType
  namespace: string
  document_count: number
  updated_at: string
  created_at: string
  user_id: number
  /** Group identifier (namespace or 'default') */
  group_id: string
  /** Display name for the group */
  group_name: string
  /** Type of group */
  group_type: KnowledgeGroupType
  /** Current user's role for this KB: 'Owner' | 'Maintainer' | 'Developer' | 'Reporter' | 'RestrictedAnalyst' | null */
  my_role?: MemberRole | null
}

/** Personal knowledge bases in all-grouped response */
export interface AllGroupedPersonal {
  created_by_me: KnowledgeBaseWithGroupInfo[]
  shared_with_me: KnowledgeBaseWithGroupInfo[]
}

/** Team group in all-grouped response */
export interface AllGroupedTeamGroup {
  group_name: string
  group_display_name: string
  kb_count: number
  knowledge_bases: KnowledgeBaseWithGroupInfo[]
}

/** Organization knowledge bases in all-grouped response */
export interface AllGroupedOrganization {
  namespace: string | null
  display_name: string | null
  kb_count: number
  knowledge_bases: KnowledgeBaseWithGroupInfo[]
}

/** Summary counts in all-grouped response */
export interface AllGroupedSummary {
  total_count: number
  personal_count: number
  group_count: number
  organization_count: number
}

/**
 * Response for GET /api/v1/knowledge-bases/all-grouped
 * Returns all knowledge bases accessible to the user in a single request,
 * solving the N+1 query problem.
 */
export interface AllGroupedKnowledgeResponse {
  personal: AllGroupedPersonal
  groups: AllGroupedTeamGroup[]
  organization: AllGroupedOrganization
  summary: AllGroupedSummary
}
