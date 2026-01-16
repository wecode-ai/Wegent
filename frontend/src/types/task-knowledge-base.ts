// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Types for task knowledge base binding feature
 */

export interface KnowledgeBaseRef {
  name: string
  namespace: string
  boundBy?: string
  boundAt?: string
}

export interface BoundKnowledgeBaseDetail {
  id: number
  name: string
  namespace: string
  display_name: string
  description?: string
  document_count: number
  bound_by: string
  bound_at: string
}

export interface BoundKnowledgeBaseListResponse {
  items: BoundKnowledgeBaseDetail[]
  total: number
  max_limit: number
}

export interface BindKnowledgeBaseRequest {
  kb_name: string
  kb_namespace: string
}

export interface UnbindKnowledgeBaseResponse {
  message: string
  kb_name: string
  kb_namespace: string
}
