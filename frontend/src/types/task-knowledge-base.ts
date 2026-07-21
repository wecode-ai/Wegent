// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Types for task knowledge base binding feature
 */

import type { ExternalKnowledgeRef } from './context'
import type { ContextWarning } from './api'

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
  scope_restricted?: boolean
  document_ids?: number[]
  folder_ids?: number[]
  include_subfolders?: boolean
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

export interface BoundExternalKnowledgeRefListResponse {
  items: ExternalKnowledgeRef[]
  total: number
  context_warnings?: ContextWarning[]
}

export interface BindExternalKnowledgeRefsResponse {
  message: string
  items: ExternalKnowledgeRef[]
  total: number
}

export interface RemoveExternalKnowledgeRefResponse {
  message: string
  items: ExternalKnowledgeRef[]
  total: number
}
