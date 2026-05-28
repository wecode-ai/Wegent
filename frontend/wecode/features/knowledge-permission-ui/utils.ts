// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from 'i18next'
import type { MemberRole } from '@/types/knowledge'
import { COLLABORATOR_TYPE_ORDER } from './types'
import type { CollaboratorInfo, SearchResultItem } from './types'

const ROLE_DISPLAY_KEYS: Record<MemberRole, string> = {
  Maintainer: 'document.permission.roles.Maintainer',
  Developer: 'document.permission.roles.Developer',
  Reporter: 'document.permission.roles.Reporter',
  RestrictedAnalyst: 'document.permission.roles.RestrictedAnalyst',
  Owner: 'document.permission.roles.Owner',
}

export function getRoleDisplayName(role: MemberRole, t?: TFunction): string {
  if (t) {
    return t(ROLE_DISPLAY_KEYS[role] || role, {
      defaultValue: role,
    })
  }
  // Fallback to raw role name when no t function provided
  return role
}

export function getRoleDescription(role: MemberRole, t: TFunction): string {
  const key = `groupMembers.roleDescriptions.${role}`
  return t(key, { ns: 'groups', defaultValue: role })
}

export function sortCollaborators(list: CollaboratorInfo[]): CollaboratorInfo[] {
  return [...list].sort((a, b) => {
    const typeDiff =
      (COLLABORATOR_TYPE_ORDER[a.entity_type] ?? 99) -
      (COLLABORATOR_TYPE_ORDER[b.entity_type] ?? 99)
    if (typeDiff !== 0) return typeDiff
    return new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime()
  })
}

/**
 * Parse display_name from backend to extract employee_id for separate styling.
 *
 * Backend format (share_service_patch.py):
 *   - With ERP + employee_id: "erp_name (employee_id)"  e.g. "吴华 (EMP001)"
 *   - With ERP only: "erp_name"
 *   - Without ERP: original user_name
 *
 * Frontend renders employee_id in gray brackets after the name.
 */
export function parseCollaboratorDisplayName(rawName: string): {
  name: string
  employeeId: string | null
} {
  const match = rawName.match(/^(.+?)\s+\(([^)]+)\)$/)
  return match ? { name: match[1], employeeId: match[2] } : { name: rawName, employeeId: null }
}

/** Build a unique key for a search result item (used in add collaborator flow). */
export function buildSearchResultItemKey(item: SearchResultItem): string {
  if (item.type === 'user') return `user-${item.id}`
  const entityType = item.type === 'group' ? 'namespace' : 'org_department'
  const entityId = item.type === 'group' ? String(item.id) : (item.id as string)
  return `entity-${entityType}-${entityId}`
}

/** Build a unique key for an API response item (succeeded/failed from batch add). */
export function buildResponseItemKey(item: {
  entity_type?: string | null
  entity_id?: string | null
  user_id?: number
}): string {
  if (!item.entity_type || item.entity_type === 'user') return `user-${item.user_id}`
  return `entity-${item.entity_type}-${item.entity_id}`
}
