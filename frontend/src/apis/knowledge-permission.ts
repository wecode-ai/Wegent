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

// Type for unified share API member response
interface ResourceMemberResponse {
  id: number
  resource_type: string
  resource_id: number
  user_id: number
  user_name: string | null
  permission_level: string
  status: string
  invited_by_user_id: number
  invited_by_user_name: string | null
  reviewed_by_user_id: number | null
  reviewed_by_user_name: string | null
  reviewed_at: string | null
  copied_resource_id: number | null
  requested_at: string
  created_at: string
  updated_at: string
}
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
      `/share/KnowledgeBase/${kbId}/join`,
      {
        share_token: '', // Will be filled by the caller
        requested_permission_level: request.permission_level,
      }
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
      `/share/KnowledgeBase/${kbId}/requests/${permissionId}/review`,
      {
        approved: request.action === 'approve',
        permission_level: request.permission_level,
      }
    )
    return response
  },

  /**
   * List all permissions for a knowledge base
   */
  listPermissions: async (kbId: number): Promise<PermissionListResponse> => {
    const response = await client.get<{ members: ResourceMemberResponse[]; total: number }>(
      `/share/KnowledgeBase/${kbId}/members`
    )
    // Transform unified share API response to PermissionListResponse format
    const pending = response.members
      .filter(m => m.status === 'pending')
      .map(m => ({
        id: m.id,
        user_id: m.user_id,
        username: m.user_name || '',
        email: '',
        permission_level: m.permission_level as 'view' | 'edit' | 'manage',
        requested_at: m.requested_at,
      }))
    const approved = response.members
      .filter(m => m.status === 'approved')
      .reduce(
        (acc, m) => {
          const level = m.permission_level as 'view' | 'edit' | 'manage'
          if (!acc[level]) acc[level] = []
          const member: {
            id: number
            user_id: number
            username: string
            email: string
            permission_level: 'view' | 'edit' | 'manage'
            requested_at: string
            reviewed_at?: string
            reviewed_by?: number
          } = {
            id: m.id,
            user_id: m.user_id,
            username: m.user_name || '',
            email: '',
            permission_level: level,
            requested_at: m.requested_at,
          }
          if (m.reviewed_at) {
            member.reviewed_at = m.reviewed_at
          }
          if (m.reviewed_by_user_id) {
            member.reviewed_by = m.reviewed_by_user_id
          }
          acc[level].push(member)
          return acc
        },
        { view: [], edit: [], manage: [] } as {
          view: typeof pending
          edit: typeof pending
          manage: typeof pending
        }
      )
    return { pending, approved }
  },

  /**
   * Directly add permission for a user
   */
  addPermission: async (
    kbId: number,
    request: PermissionAddRequest
  ): Promise<PermissionResponse> => {
    // First, get user ID from username
    const usersResponse = await client.get<{ items: { id: number; user_name: string }[] }>('/users')
    const user = usersResponse.items.find(u => u.user_name === request.user_name)
    if (!user) {
      throw new Error('User not found')
    }
    const response = await client.post<PermissionResponse>(`/share/KnowledgeBase/${kbId}/members`, {
      user_id: user.id,
      permission_level: request.permission_level,
    })
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
      `/share/KnowledgeBase/${kbId}/members/${permissionId}`,
      {
        permission_level: request.permission_level,
      }
    )
    return response
  },

  /**
   * Delete (revoke) a user's permission
   */
  deletePermission: async (kbId: number, permissionId: number): Promise<{ message: string }> => {
    const response = await client.delete<{ message: string }>(
      `/share/KnowledgeBase/${kbId}/members/${permissionId}`
    )
    return response
  },

  /**
   * Get current user's permission for a knowledge base
   */
  getMyPermission: async (kbId: number): Promise<MyPermissionResponse> => {
    const response = await client.get<MyPermissionResponse>(
      `/share/KnowledgeBase/${kbId}/my-permission`
    )
    return response
  },

  /**
   * Get knowledge base info for share page
   */
  getShareInfo: async (kbId: number): Promise<KBShareInfo> => {
    const response = await client.get<KBShareInfo>(`/share/KnowledgeBase/${kbId}/share-info`)
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
