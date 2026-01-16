// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeBasesResponse } from '@/types/api'
import type { DocumentDetailResponse, KnowledgeBaseSummaryResponse } from '@/types/knowledge'
import client from './client'

export const knowledgeBaseApi = {
  /**
   * List all knowledge bases accessible to the user
   */
  list: async (params?: {
    scope?: string
    group_name?: string
  }): Promise<KnowledgeBasesResponse> => {
    const queryParams = new URLSearchParams()
    if (params?.scope) queryParams.append('scope', params.scope)
    if (params?.group_name) queryParams.append('group_name', params.group_name)

    const queryString = queryParams.toString()
    // Use the correct endpoint from /api/knowledge-bases
    const url = `/knowledge-bases${queryString ? `?${queryString}` : ''}`

    const response = await client.get<KnowledgeBasesResponse>(url)
    return response
  },

  /**
   * Get document detail including content and summary
   */
  getDocumentDetail: async (
    kbId: number,
    docId: number,
    options?: {
      includeContent?: boolean
      includeSummary?: boolean
    }
  ): Promise<DocumentDetailResponse> => {
    const queryParams = new URLSearchParams()
    if (options?.includeContent !== undefined) {
      queryParams.append('include_content', String(options.includeContent))
    }
    if (options?.includeSummary !== undefined) {
      queryParams.append('include_summary', String(options.includeSummary))
    }

    const queryString = queryParams.toString()
    const url = `/knowledge-bases/${kbId}/documents/${docId}/detail${queryString ? `?${queryString}` : ''}`

    const response = await client.get<DocumentDetailResponse>(url)
    return response
  },

  /**
   * Refresh document summary
   */
  refreshDocumentSummary: async (kbId: number, docId: number): Promise<void> => {
    await client.post(`/knowledge-bases/${kbId}/documents/${docId}/summary/refresh`)
  },

  /**
   * Get knowledge base summary
   */
  getKnowledgeBaseSummary: async (kbId: number): Promise<KnowledgeBaseSummaryResponse> => {
    const response = await client.get<KnowledgeBaseSummaryResponse>(
      `/knowledge-bases/${kbId}/summary`
    )
    return response
  },

  /**
   * Refresh knowledge base summary
   */
  refreshKnowledgeBaseSummary: async (kbId: number): Promise<void> => {
    await client.post(`/knowledge-bases/${kbId}/summary/refresh`)
  },
}
