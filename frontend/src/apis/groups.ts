// SPDX-FileCopyrightText: 2025 Weibo, Inc.
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
  AddMemberResult,
} from '@/types/group'

/**
 * List user's groups (created + joined)
 */
export const listGroups = async (params?: {
  page?: number
  limit?: number
}): Promise<GroupListResponse> => {
  const queryString = params
    ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
    : ''
  return await apiClient.get<GroupListResponse>(`/groups${queryString}`)
}

/**
 * Create a new group
 */
export const createGroup = async (data: GroupCreate): Promise<Group> => {
  return await apiClient.post<Group>('/groups', data)
}

/**
 * Get group details
 */
export const getGroup = async (groupName: string): Promise<Group> => {
  return await apiClient.get<Group>(`/groups/${encodeURIComponent(groupName)}`)
}

/**
 * Update group information
 */
export const updateGroup = async (groupName: string, data: GroupUpdate): Promise<Group> => {
  return await apiClient.put<Group>(`/groups/${encodeURIComponent(groupName)}`, data)
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
export const listGroupMembers = async (groupName: string): Promise<GroupMemberListResponse> => {
  return await apiClient.get<GroupMemberListResponse>(
    `/groups/${encodeURIComponent(groupName)}/members`
  )
}

/**
 * Add a member to the group
 */
export const addGroupMember = async (
  groupName: string,
  data: GroupMemberCreate
): Promise<GroupMember> => {
  return await apiClient.post<GroupMember>(`/groups/${encodeURIComponent(groupName)}/members`, data)
}

/**
 * Add a member to the group by username
 */
export const addGroupMemberByUsername = async (
  groupName: string,
  username: string,
  role: string
): Promise<AddMemberResult> => {
  return await apiClient.post<AddMemberResult>(
    `/groups/${encodeURIComponent(groupName)}/members/by-username?username=${encodeURIComponent(username)}&role=${role}`
  )
}

/**
 * Update a member's role
 */
export const updateGroupMemberRole = async (
  groupName: string,
  userId: number,
  data: GroupMemberUpdate
): Promise<GroupMember> => {
  return await apiClient.put<GroupMember>(
    `/groups/${encodeURIComponent(groupName)}/members/${userId}`,
    data
  )
}

/**
 * Remove a member from the group
 */
export const removeGroupMember = async (groupName: string, userId: number): Promise<void> => {
  await apiClient.delete(`/groups/${encodeURIComponent(groupName)}/members/${userId}`)
}

/**
 * Invite all system users to the group as Reporters
 */
export const inviteAllUsers = async (groupName: string): Promise<void> => {
  await apiClient.post(`/groups/${encodeURIComponent(groupName)}/members/invite-all`)
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
