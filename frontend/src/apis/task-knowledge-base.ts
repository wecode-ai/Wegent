// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client for task knowledge base binding
 */

import type {
  BoundKnowledgeBaseDetail,
  BoundKnowledgeBaseListResponse,
  UnbindKnowledgeBaseResponse,
} from '@/types/task-knowledge-base'
import client from './client'

export const taskKnowledgeBaseApi = {
  /**
   * Get knowledge bases bound to a group chat task
   */
  getBoundKnowledgeBases: async (taskId: number): Promise<BoundKnowledgeBaseListResponse> => {
    return client.get<BoundKnowledgeBaseListResponse>(`/tasks/${taskId}/knowledge-bases`)
  },

  /**
   * Bind a knowledge base to a group chat task
   */
  bindKnowledgeBase: async (
    taskId: number,
    kbName: string,
    kbNamespace: string = 'default'
  ): Promise<BoundKnowledgeBaseDetail> => {
    return client.post<BoundKnowledgeBaseDetail>(`/tasks/${taskId}/knowledge-bases`, {
      kb_name: kbName,
      kb_namespace: kbNamespace,
    })
  },

  /**
   * Unbind a knowledge base from a group chat task
   */
  unbindKnowledgeBase: async (
    taskId: number,
    kbName: string,
    kbNamespace: string = 'default'
  ): Promise<UnbindKnowledgeBaseResponse> => {
    const params = new URLSearchParams()
    if (kbNamespace !== 'default') {
      params.append('kb_namespace', kbNamespace)
    }
    const query = params.toString()
    return client.delete<UnbindKnowledgeBaseResponse>(
      `/tasks/${taskId}/knowledge-bases/${kbName}${query ? `?${query}` : ''}`
    )
  },
}
