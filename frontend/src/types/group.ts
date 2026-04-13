// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Group (Namespace) related types
 */

// Import BaseRole from base-role module
import type { BaseRole } from './base-role'

// Re-export GroupRole as backward compatible alias
export type GroupRole = BaseRole

export type GroupVisibility = 'private' | 'internal' | 'public'

export type GroupLevel = 'group' | 'organization'

export interface Group {
  id: number
  name: string
  display_name: string | null
  parent_name: string | null
  owner_user_id: number
  visibility: GroupVisibility
  level?: GroupLevel | null
  description: string | null
  is_active: boolean
  member_count?: number
  resource_count?: number
  my_role?: GroupRole
  created_at: string
  updated_at: string
}

export interface GroupCreate {
  name: string
  display_name?: string
  visibility?: GroupVisibility
  description?: string
  level?: GroupLevel
}

export interface GroupUpdate {
  display_name?: string
  visibility?: GroupVisibility
  description?: string
  level?: GroupLevel
}

export interface GroupMember {
  id: number
  group_name: string
  user_id: number
  user_name?: string
  role: GroupRole
  invited_by_user_id: number | null
  invited_by_user_name?: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface GroupMemberCreate {
  user_id: number
  role: GroupRole
}

export interface GroupMemberUpdate {
  role: GroupRole
}

export interface GroupMemberBatchUpdateItem {
  user_id: number
  role: GroupRole
}

export interface GroupMemberBatchUpdateRequest {
  updates: GroupMemberBatchUpdateItem[]
}

export interface GroupMemberBatchUpdateFailedItem {
  user_id: number
  role: GroupRole
  error: string
  error_code?: string | null
}

export interface GroupMemberBatchUpdateResponse {
  updated_members: GroupMember[]
  failed_updates: GroupMemberBatchUpdateFailedItem[]
  total_updated: number
  total_failed: number
}

export interface GroupListResponse {
  total: number
  items: Group[]
}

export interface GroupMemberListResponse {
  total: number
  items: GroupMember[]
}

/**
 * Result of adding a member operation
 */
export interface AddMemberResult {
  success: boolean
  message: string
  data: GroupMember | null
}

/**
 * Scope type for resource queries
 */
export type ResourceScope = 'personal' | 'group' | 'all'

/**
 * Resource source label for display
 */
export type ResourceSource = 'personal' | 'shared' | 'public' | string // string for group names
