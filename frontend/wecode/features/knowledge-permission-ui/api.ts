// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MemberRole } from '@/types/knowledge'
import { searchGroups } from '@/apis/groups'
import client from '@/apis/client'
import type { SearchResultItem } from './types'

export interface ResourceMemberResponse {
  id: number
  resource_type: string
  resource_id: number
  user_id: number
  display_name: string | null
  user_email: string | null
  role: string
  status: string
  entity_type?: string | null
  entity_id?: string | null
  entity_display_name?: string | null
  source_type?: string | null
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

export interface FailedMemberResponse {
  user_id: number
  entity_type?: string
  entity_id?: string
  error: string
}

export interface BatchAddResponse {
  succeeded: ResourceMemberResponse[]
  failed: FailedMemberResponse[]
}

export async function fetchCollaborators(kbId: number): Promise<ResourceMemberResponse[]> {
  const res = await client.get<{ members: ResourceMemberResponse[] }>(
    `/share/KnowledgeBase/${kbId}/members`
  )
  return res.members
}

export async function updateCollaboratorRole(
  kbId: number,
  permissionId: number,
  role: MemberRole
): Promise<void> {
  await client.put(`/share/KnowledgeBase/${kbId}/members/${permissionId}`, { role })
}

export async function removeCollaborator(kbId: number, permissionId: number): Promise<void> {
  await client.delete(`/share/KnowledgeBase/${kbId}/members/${permissionId}`)
}

export async function batchAddMembers(
  kbId: number,
  members: {
    user_id: number
    role: MemberRole
    entity_type?: string
    entity_id?: string
    entity_display_name?: string
  }[]
): Promise<BatchAddResponse> {
  return await client.post<BatchAddResponse>(`/share/KnowledgeBase/${kbId}/members/batch`, {
    members,
  })
}

export async function searchUsers(query: string): Promise<SearchResultItem[]> {
  const res = await client.get<{
    users: {
      id: number
      user_name: string
      email: string | null
      erp_name?: string | null
      employee_id?: string | null
      department_name?: string | null
    }[]
  }>(`/wecode/users/search?q=${encodeURIComponent(query)}&limit=20`)
  return res.users.map(u => ({
    id: u.id,
    name: u.erp_name || u.user_name,
    type: 'user' as const,
    metadata: {
      email: u.email,
      employeeId: u.employee_id,
      departmentName: u.department_name,
    },
  }))
}

export async function searchGroupsApi(query: string): Promise<SearchResultItem[]> {
  const res = await searchGroups({ q: query, limit: 20 })
  return (res.items || []).map(g => ({
    id: g.id,
    name: g.display_name || g.name,
    type: 'group' as const,
    metadata: { visibility: g.visibility, level: g.level },
  }))
}

export async function searchDepartmentsApi(query: string): Promise<SearchResultItem[]> {
  const res = await client.get<{
    departments: { id: string; name: string; label?: string }[]
  }>(`/internal/departments/search?q=${encodeURIComponent(query)}`)
  return res.departments.map(d => ({
    id: d.id,
    name: d.name,
    type: 'department' as const,
    metadata: { label: d.label },
  }))
}
