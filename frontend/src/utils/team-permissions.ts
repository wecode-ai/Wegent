// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'
import type { BaseRole } from '@/types/base-role'
import { isEditor } from '@/types/base-role'

/**
 * Check if a team belongs to a group (non-default namespace)
 */
export function isGroupTeam(team: Team): boolean {
  return !!team.namespace && team.namespace !== 'default'
}

/**
 * Check if a team is a public/system team (user_id = 0)
 */
export function isPublicTeam(team: Team): boolean {
  return team.user_id === 0
}

/**
 * Check if a team is a shared team (share_status = 2)
 */
export function isSharedTeam(team: Team): boolean {
  return team.share_status === 2
}

/**
 * Check if the current user can edit a given team.
 *
 * Rules:
 * - Public teams (user_id=0) are read-only
 * - Shared teams (share_status=2) are read-only
 * - Group teams require Owner/Maintainer/Developer role
 * - Personal teams are always editable by their owner
 */
export function canEditTeam(
  team: Team,
  userId: number,
  groupRoleMap?: Map<string, BaseRole>
): boolean {
  if (isPublicTeam(team)) return false
  if (isSharedTeam(team)) return false
  if (isGroupTeam(team)) {
    if (!groupRoleMap) return false
    const role = groupRoleMap.get(team.namespace!)
    return isEditor(role)
  }
  return team.user_id === userId
}
