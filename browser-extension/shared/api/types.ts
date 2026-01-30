// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API Types shared across the extension
 */

export interface User {
  id: number
  user_name: string
  avatar?: string
  role?: string
}

export interface LoginRequest {
  user_name: string
  password: string
}

export interface LoginResponse {
  access_token: string
  token_type: string
}

export interface AttachmentResponse {
  id: number
  filename: string
  file_size: number
  mime_type: string
  status: string
  file_extension: string
  text_length?: number
  error_message?: string
  created_at: string
}

export interface KnowledgeBase {
  id: number
  name: string
  namespace: string
  description?: string
  document_count: number
  created_at: string
  updated_at: string
}

export interface KnowledgeBaseListResponse {
  total: number
  items: KnowledgeBase[]
}

export interface KnowledgeDocumentCreate {
  attachment_id: number
  source_type: 'ATTACHMENT' | 'TEXT' | 'URL'
  name: string
  metadata?: {
    source_url?: string
    extracted_at?: string
  }
}

export interface KnowledgeDocumentResponse {
  id: number
  name: string
  source_type: string
  status: string
  created_at: string
}

export interface TaskCreate {
  team_id?: number
  prompt?: string
  title?: string
}

export interface TaskResponse {
  id: number
  title?: string
  status: string
  created_at: string
}
export interface ApiError {
  detail: string | { message: string; error_code?: string }
}

/**
 * OpenAPI v1/responses types
 */
export interface ResponseCreateInput {
  model: string // Format: "namespace#team_name" or "namespace#team_name#model_id"
  input: string | ResponseInputMessage[]
  stream?: boolean
  previous_response_id?: string
  tools?: ResponseTool[]
}

export interface ResponseInputMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ResponseInputContent[]
}

export interface ResponseInputContent {
  type: 'input_text' | 'input_file'
  text?: string
  file_id?: string
}

export interface ResponseTool {
  type: 'wegent_chat_bot' | 'wegent_workspace'
  workspace?: {
    git_url?: string
    git_repo?: string
    git_domain?: string
    branch?: string
  }
}

export interface ResponseOutputMessage {
  id: string
  status: 'in_progress' | 'completed' | 'incomplete'
  content: ResponseOutputContent[]
  role: 'user' | 'assistant'
}

export interface ResponseOutputContent {
  type: 'output_text'
  text: string
}

export interface ResponseObject {
  id: string // Format: "resp_{task_id}"
  created_at: number
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'incomplete'
  error?: {
    code: string
    message: string
  }
  model: string
  output: ResponseOutputMessage[]
  previous_response_id?: string
}

/**
 * Unified Model types
 */
export interface UnifiedModel {
  name: string
  type: 'public' | 'user' | 'group'
  displayName?: string | null
  provider?: string | null
  modelId?: string | null
  namespace: string
  modelCategoryType?: string
}

export interface UnifiedModelListResponse {
  models: UnifiedModel[]
}
