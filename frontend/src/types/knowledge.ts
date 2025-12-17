// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base and document related types
 */

export type DocumentStatus = 'enabled' | 'disabled'

export type KnowledgeResourceScope = 'personal' | 'group' | 'all'

// Knowledge Base types
export interface KnowledgeBase {
  id: number
  name: string
  description: string | null
  user_id: number
  namespace: string
  document_count: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface KnowledgeBaseCreate {
  name: string
  description?: string
  namespace?: string
}

export interface KnowledgeBaseUpdate {
  name?: string
  description?: string
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
  created_at: string
  updated_at: string
}

export interface KnowledgeDocumentCreate {
  attachment_id: number
  name: string
  file_extension: string
  file_size: number
}

export interface KnowledgeDocumentUpdate {
  name?: string
  status?: DocumentStatus
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
