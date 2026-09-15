// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MemberRole } from '@/types/knowledge'

export type CollaboratorType = 'user' | 'group' | 'department'

export interface CollaboratorInfo {
  id: number
  display_name: string
  added_by_name: string
  role: MemberRole
  entity_type: 'user' | 'namespace' | 'org_department'
  entity_id?: string
  requested_at: string
  employee_id?: string | null
}

export interface SearchResultItem {
  id: string | number
  name: string
  type: CollaboratorType
  metadata?: {
    email?: string | null
    employeeId?: string | null
    departmentName?: string | null
    visibility?: string
    level?: string | null
    label?: string
  }
}

export const COLLABORATOR_TYPE_ORDER: Record<string, number> = {
  user: 0,
  namespace: 1,
  org_department: 2,
}
