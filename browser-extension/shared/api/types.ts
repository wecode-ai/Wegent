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
