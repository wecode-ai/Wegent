// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * API client for task members (group chat) functionality.
 */

import apiClient from './client'

// Types for task members
export interface TaskMember {
  id: number
  task_id: number
  user_id: number
  username: string
  avatar: string | null
  invited_by: number
  inviter_name: string
  status: 'ACTIVE' | 'REMOVED'
  joined_at: string
  is_owner: boolean
}

export interface TaskMemberListResponse {
  members: TaskMember[]
  total: number
  task_owner_id: number
}

export interface InviteLinkResponse {
  invite_url: string
  invite_token: string
  expires_hours: number
}

export interface InviteInfoResponse {
  task_id: number
  task_title: string
  inviter_id: number
  inviter_name: string
  team_name: string | null
  member_count: number
  expires_at: string
}

export interface JoinByInviteResponse {
  message: string
  task_id: number
  already_member: boolean
}

export interface ConvertToGroupChatResponse {
  message: string
  task_id: number
  is_group_chat: boolean
}

// Task members API
export const taskMemberApi = {
  /**
   * Convert an existing task to a group chat.
   * Only the task owner can convert.
   */
  convertToGroupChat: async (taskId: number): Promise<ConvertToGroupChatResponse> => {
    return apiClient.post<ConvertToGroupChatResponse>(`/tasks/${taskId}/convert-to-group-chat`)
  },

  /**
   * Get all active members of a task (group chat).
   */
  getMembers: async (taskId: number): Promise<TaskMemberListResponse> => {
    return apiClient.get<TaskMemberListResponse>(`/tasks/${taskId}/members`)
  },

  /**
   * Manually add a user to a task (group chat).
   */
  addMember: async (taskId: number, userId: number): Promise<TaskMember> => {
    return apiClient.post<TaskMember>(`/tasks/${taskId}/members`, {
      user_id: userId,
    })
  },

  /**
   * Remove a member from a task (group chat).
   */
  removeMember: async (taskId: number, userId: number): Promise<void> => {
    return apiClient.delete<void>(`/tasks/${taskId}/members/${userId}`)
  },

  /**
   * Leave a group chat (remove yourself).
   */
  leaveGroupChat: async (taskId: number): Promise<void> => {
    return apiClient.post<void>(`/tasks/${taskId}/leave`)
  },

  /**
   * Generate an invite link for a group chat.
   */
  generateInviteLink: async (
    taskId: number,
    expiresHours: number = 72
  ): Promise<InviteLinkResponse> => {
    return apiClient.post<InviteLinkResponse>(
      `/tasks/${taskId}/invite-link?expires_hours=${expiresHours}`
    )
  },

  /**
   * Get invite information (no authentication required).
   * Used to display the invite confirmation page.
   */
  getInviteInfo: async (token: string): Promise<InviteInfoResponse> => {
    // This endpoint doesn't require auth, so we use fetch directly
    const response = await fetch(`/api/tasks/invite/info?token=${encodeURIComponent(token)}`)
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.detail || 'Invalid invite link')
    }
    return response.json()
  },

  /**
   * Join a group chat via invite link.
   */
  joinByInvite: async (token: string): Promise<JoinByInviteResponse> => {
    return apiClient.post<JoinByInviteResponse>(
      `/tasks/invite/join?token=${encodeURIComponent(token)}`
    )
  },
}

export default taskMemberApi
