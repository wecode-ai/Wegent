// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client for task knowledge base binding
 */

import type {
  BindExternalKnowledgeRefsResponse,
  BoundExternalKnowledgeRefListResponse,
  BoundKnowledgeBaseDetail,
  BoundKnowledgeBaseListResponse,
  RemoveExternalKnowledgeRefResponse,
  UnbindKnowledgeBaseResponse,
} from '@/types/task-knowledge-base'
import type { ExternalKnowledgeRef } from '@/types/context'
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
    kbNamespace: string = 'default',
    kbId?: number
  ): Promise<UnbindKnowledgeBaseResponse> => {
    const params = new URLSearchParams()
    if (kbNamespace !== 'default') {
      params.append('kb_namespace', kbNamespace)
    }
    if (kbId !== undefined) {
      params.append('kb_id', String(kbId))
    }
    const query = params.toString()
    return client.delete<UnbindKnowledgeBaseResponse>(
      `/tasks/${taskId}/knowledge-bases/${kbName}${query ? `?${query}` : ''}`
    )
  },

  /**
   * Get external knowledge refs bound to a task
   */
  getBoundExternalKnowledgeRefs: async (
    taskId: number
  ): Promise<BoundExternalKnowledgeRefListResponse> => {
    return client.get<BoundExternalKnowledgeRefListResponse>(
      `/tasks/${taskId}/external-knowledge-refs`
    )
  },

  /**
   * Bind external knowledge refs to a task
   */
  bindExternalKnowledgeRefs: async (
    taskId: number,
    refs: ExternalKnowledgeRef[]
  ): Promise<BindExternalKnowledgeRefsResponse> => {
    return client.post<BindExternalKnowledgeRefsResponse>(
      `/tasks/${taskId}/external-knowledge-refs`,
      { refs }
    )
  },

  /**
   * Remove one external knowledge ref from a task
   */
  removeExternalKnowledgeRef: async (
    taskId: number,
    ref: ExternalKnowledgeRef
  ): Promise<RemoveExternalKnowledgeRefResponse> => {
    return client.post<RemoveExternalKnowledgeRefResponse>(
      `/tasks/${taskId}/external-knowledge-refs/remove`,
      { ref }
    )
  },
}
