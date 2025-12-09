// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Group API client
 */

import { apiClient } from './client'
import type {
  Group,
  GroupCreate,
  GroupUpdate,
  GroupListResponse,
  GroupMember,
  GroupMemberCreate,
  GroupMemberUpdate,
  GroupMemberListResponse,
} from '@/types/group'

/**
 * List user's groups (created + joined)
 */
export const listGroups = async (params?: {
  page?: number
  limit?: number
}): Promise<GroupListResponse> => {
  const response = await apiClient.get('/groups', { params })
  return response.data
}

/**
 * Create a new group
 */
export const createGroup = async (data: GroupCreate): Promise<Group> => {
  const response = await apiClient.post('/groups', data)
  return response.data
}

/**
 * Get group details
 */
export const getGroup = async (groupName: string): Promise<Group> => {
  const response = await apiClient.get(`/groups/${encodeURIComponent(groupName)}`)
  return response.data
}

/**
 * Update group information
 */
export const updateGroup = async (
  groupName: string,
  data: GroupUpdate
): Promise<Group> => {
  const response = await apiClient.put(`/groups/${encodeURIComponent(groupName)}`, data)
  return response.data
}

/**
 * Delete a group
 */
export const deleteGroup = async (groupName: string): Promise<void> => {
  await apiClient.delete(`/groups/${encodeURIComponent(groupName)}`)
}

/**
 * List group members
 */
export const listGroupMembers = async (
  groupName: string
): Promise<GroupMemberListResponse> => {
  const response = await apiClient.get(
    `/groups/${encodeURIComponent(groupName)}/members`
  )
  return response.data
}

/**
 * Add a member to the group
 */
export const addGroupMember = async (
  groupName: string,
  data: GroupMemberCreate
): Promise<GroupMember> => {
  const response = await apiClient.post(
    `/groups/${encodeURIComponent(groupName)}/members`,
    data
  )
  return response.data
}

/**
 * Update a member's role
 */
export const updateGroupMemberRole = async (
  groupName: string,
  userId: number,
  data: GroupMemberUpdate
): Promise<GroupMember> => {
  const response = await apiClient.put(
    `/groups/${encodeURIComponent(groupName)}/members/${userId}`,
    data
  )
  return response.data
}

/**
 * Remove a member from the group
 */
export const removeGroupMember = async (
  groupName: string,
  userId: number
): Promise<void> => {
  await apiClient.delete(
    `/groups/${encodeURIComponent(groupName)}/members/${userId}`
  )
}

/**
 * Invite all system users to the group as Reporters
 */
export const inviteAllUsers = async (groupName: string): Promise<void> => {
  await apiClient.post(
    `/groups/${encodeURIComponent(groupName)}/members/invite-all`
  )
}

/**
 * Leave a group (current user)
 */
export const leaveGroup = async (groupName: string): Promise<void> => {
  await apiClient.post(`/groups/${encodeURIComponent(groupName)}/leave`)
}

/**
 * Transfer ownership to another Maintainer
 */
export const transferOwnership = async (
  groupName: string,
  newOwnerUserId: number
): Promise<void> => {
  await apiClient.post(`/groups/${encodeURIComponent(groupName)}/transfer-ownership`, {
    new_owner_user_id: newOwnerUserId,
  })
}
