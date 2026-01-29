// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge Base API
 */

import { apiRequest } from './client'
import type {
  KnowledgeBase,
  KnowledgeBaseListResponse,
  KnowledgeDocumentCreate,
  KnowledgeDocumentResponse,
} from './types'

/**
 * List all accessible knowledge bases
 */
export async function listKnowledgeBases(
  scope: 'personal' | 'group' | 'all' = 'all',
): Promise<KnowledgeBase[]> {
  const response = await apiRequest<KnowledgeBaseListResponse>(
    `/knowledge?scope=${scope}`,
  )
  return response.items
}

/**
 * Get a knowledge base by ID
 */
export async function getKnowledgeBase(id: number): Promise<KnowledgeBase> {
  return apiRequest<KnowledgeBase>(`/knowledge/${id}`)
}

/**
 * Add a document to a knowledge base
 */
export async function addDocumentToKnowledgeBase(
  knowledgeBaseId: number,
  data: KnowledgeDocumentCreate,
): Promise<KnowledgeDocumentResponse> {
  return apiRequest<KnowledgeDocumentResponse>(
    `/knowledge/${knowledgeBaseId}/documents`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  )
}
