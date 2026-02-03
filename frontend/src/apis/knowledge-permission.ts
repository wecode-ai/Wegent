// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  JoinByLinkRequest,
  JoinByLinkResponse,
  KBShareInfo,
  MyPermissionResponse,
  PermissionAddRequest,
  PermissionApplyRequest,
  PermissionApplyResponse,
  PermissionListResponse,
  PermissionResponse,
  PermissionReviewRequest,
  PermissionReviewResponse,
  PermissionUpdateRequest,
  PublicKnowledgeBaseResponse,
  ShareLinkConfig,
  ShareLinkResponse,
} from '@/types/knowledge'
import client from './client'

export const knowledgePermissionApi = {
  /**
   * Apply for knowledge base access permission
   */
  applyPermission: async (
    kbId: number,
    request: PermissionApplyRequest
  ): Promise<PermissionApplyResponse> => {
    const response = await client.post<PermissionApplyResponse>(
      `/knowledge-bases/${kbId}/permissions/apply`,
      request
    )
    return response
  },

  /**
   * Review a permission request (approve or reject)
   */
  reviewPermission: async (
    kbId: number,
    permissionId: number,
    request: PermissionReviewRequest
  ): Promise<PermissionReviewResponse> => {
    const response = await client.post<PermissionReviewResponse>(
      `/knowledge-bases/${kbId}/permissions/${permissionId}/review`,
      request
    )
    return response
  },

  /**
   * List all permissions for a knowledge base
   */
  listPermissions: async (kbId: number): Promise<PermissionListResponse> => {
    const response = await client.get<PermissionListResponse>(
      `/knowledge-bases/${kbId}/permissions`
    )
    return response
  },

  /**
   * Directly add permission for a user
   */
  addPermission: async (
    kbId: number,
    request: PermissionAddRequest
  ): Promise<PermissionResponse> => {
    const response = await client.post<PermissionResponse>(
      `/knowledge-bases/${kbId}/permissions`,
      request
    )
    return response
  },

  /**
   * Update a user's permission level
   */
  updatePermission: async (
    kbId: number,
    permissionId: number,
    request: PermissionUpdateRequest
  ): Promise<PermissionResponse> => {
    const response = await client.put<PermissionResponse>(
      `/knowledge-bases/${kbId}/permissions/${permissionId}`,
      request
    )
    return response
  },

  /**
   * Delete (revoke) a user's permission
   */
  deletePermission: async (kbId: number, permissionId: number): Promise<{ message: string }> => {
    const response = await client.delete<{ message: string }>(
      `/knowledge-bases/${kbId}/permissions/${permissionId}`
    )
    return response
  },

  /**
   * Get current user's permission for a knowledge base
   */
  getMyPermission: async (kbId: number): Promise<MyPermissionResponse> => {
    const response = await client.get<MyPermissionResponse>(
      `/knowledge-bases/${kbId}/permissions/my`
    )
    return response
  },

  /**
   * Get knowledge base info for share page
   */
  getShareInfo: async (kbId: number): Promise<KBShareInfo> => {
    const response = await client.get<KBShareInfo>(`/knowledge-bases/${kbId}/share-info`)
    return response
  },

  /**
   * Get public knowledge base info by share token (no auth required)
   */
  getPublicKnowledgeBase: async (token: string): Promise<PublicKnowledgeBaseResponse> => {
    const response = await client.get<PublicKnowledgeBaseResponse>(
      `/share/public/knowledge?token=${encodeURIComponent(token)}`
    )
    return response
  },

  /**
   * Get share token for KB redirect (no auth required)
   */
  getShareTokenByKbId: async (kbId: number): Promise<{ share_token: string }> => {
    const response = await client.get<{ share_token: string }>(
      `/share/public/knowledge/redirect?kb_id=${kbId}`
    )
    return response
  },

  /**
   * Create or get share link for knowledge base
   */
  createShareLink: async (kbId: number, config?: ShareLinkConfig): Promise<ShareLinkResponse> => {
    const response = await client.post<ShareLinkResponse>(`/share/KnowledgeBase/${kbId}/link`, {
      config: config || { require_approval: true, default_permission_level: 'view' },
    })
    return response
  },

  /**
   * Get existing share link for knowledge base
   */
  getShareLink: async (kbId: number): Promise<ShareLinkResponse | null> => {
    const response = await client.get<ShareLinkResponse | null>(`/share/KnowledgeBase/${kbId}/link`)
    return response
  },

  /**
   * Delete share link for knowledge base
   */
  deleteShareLink: async (kbId: number): Promise<{ message: string }> => {
    const response = await client.delete<{ message: string }>(`/share/KnowledgeBase/${kbId}/link`)
    return response
  },

  /**
   * Join knowledge base via share link
   */
  joinByLink: async (request: JoinByLinkRequest): Promise<JoinByLinkResponse> => {
    const response = await client.post<JoinByLinkResponse>('/share/join', request)
    return response
  },
}
