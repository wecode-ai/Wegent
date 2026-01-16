// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base and document API client
 */

import { apiClient } from './client'
import type {
  AccessibleKnowledgeResponse,
  KnowledgeBase,
  KnowledgeBaseCreate,
  KnowledgeBaseListResponse,
  KnowledgeBaseUpdate,
  KnowledgeDocument,
  KnowledgeDocumentCreate,
  KnowledgeDocumentListResponse,
  KnowledgeDocumentUpdate,
  KnowledgeResourceScope,
  TableUrlValidationResponse,
} from '@/types/knowledge'

// ============== Knowledge Base APIs ==============

/**
 * List knowledge bases
 */
export async function listKnowledgeBases(
  scope: KnowledgeResourceScope = 'all',
  groupName?: string
): Promise<KnowledgeBaseListResponse> {
  let endpoint = `/knowledge-bases?scope=${scope}`
  if (scope === 'group' && groupName) {
    endpoint += `&group_name=${encodeURIComponent(groupName)}`
  }
  return apiClient.get<KnowledgeBaseListResponse>(endpoint)
}

/**
 * Get a knowledge base by ID
 */
export async function getKnowledgeBase(id: number): Promise<KnowledgeBase> {
  return apiClient.get<KnowledgeBase>(`/knowledge-bases/${id}`)
}

/**
 * Create a new knowledge base
 */
export async function createKnowledgeBase(data: KnowledgeBaseCreate): Promise<KnowledgeBase> {
  return apiClient.post<KnowledgeBase>('/knowledge-bases', data)
}

/**
 * Update a knowledge base
 */
export async function updateKnowledgeBase(
  id: number,
  data: KnowledgeBaseUpdate
): Promise<KnowledgeBase> {
  return apiClient.put<KnowledgeBase>(`/knowledge-bases/${id}`, data)
}

/**
 * Delete a knowledge base
 */
export async function deleteKnowledgeBase(id: number): Promise<void> {
  return apiClient.delete(`/knowledge-bases/${id}`)
}

// ============== Knowledge Document APIs ==============

/**
 * List documents in a knowledge base
 */
export async function listDocuments(
  knowledgeBaseId: number
): Promise<KnowledgeDocumentListResponse> {
  return apiClient.get<KnowledgeDocumentListResponse>(
    `/knowledge-bases/${knowledgeBaseId}/documents`
  )
}

/**
 * Create a new document in a knowledge base
 */
export async function createDocument(
  knowledgeBaseId: number,
  data: KnowledgeDocumentCreate
): Promise<KnowledgeDocument> {
  return apiClient.post<KnowledgeDocument>(`/knowledge-bases/${knowledgeBaseId}/documents`, data)
}

/**
 * Update a document (enable/disable status)
 */
export async function updateDocument(
  documentId: number,
  data: KnowledgeDocumentUpdate
): Promise<KnowledgeDocument> {
  return apiClient.put<KnowledgeDocument>(`/knowledge-documents/${documentId}`, data)
}

/**
 * Delete a document
 */
export async function deleteDocument(documentId: number): Promise<void> {
  return apiClient.delete(`/knowledge-documents/${documentId}`)
}

// ============== Batch Document Operations ==============

/**
 * Batch operation result type
 */
export interface BatchOperationResult {
  success_count: number
  failed_count: number
  failed_ids: number[]
  message: string
}

/**
 * Batch delete multiple documents
 */
export async function batchDeleteDocuments(documentIds: number[]): Promise<BatchOperationResult> {
  return apiClient.post<BatchOperationResult>('/knowledge-documents/batch/delete', {
    document_ids: documentIds,
  })
}

// ============== Accessible Knowledge API ==============

/**
 * Get all accessible knowledge bases for the current user
 * (For AI chat integration)
 */
export async function getAccessibleKnowledge(): Promise<AccessibleKnowledgeResponse> {
  return apiClient.get<AccessibleKnowledgeResponse>('/knowledge-bases/accessible')
}

// ============== Table URL Validation APIs ==============

/**
 * Validate a table URL and extract metadata
 * @param url The table URL to validate
 * @returns Validation result with provider and extracted metadata
 */
export async function validateTableUrl(url: string): Promise<TableUrlValidationResponse> {
  return apiClient.post<TableUrlValidationResponse>('/tables/validate-url', { url })
}
