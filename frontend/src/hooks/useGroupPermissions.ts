// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { isEditor, isManager, type BaseRole } from '@/types/base-role'

type Scope = 'personal' | 'group' | 'all'

interface UseGroupPermissionsOptions {
  scope?: Scope
  groupName?: string
  groupRoleMap?: Map<string, BaseRole>
}

interface GroupPermissions {
  /** Check if user can edit resources in a specific namespace. Requires Owner/Maintainer/Developer role. */
  canEditGroupResource: (namespace: string) => boolean
  /** Check if user can delete resources in a specific namespace. Requires Owner/Maintainer role. */
  canDeleteGroupResource: (namespace: string) => boolean
  /** Whether user can create resources in the current group scope. Only true when scope='group' and role is Owner/Maintainer. */
  canCreateInCurrentGroup: boolean
  /** Whether user has Manager role in any group. Used for cross-group resource creation. */
  canCreateInAnyGroup: boolean
}

/**
 * Hook providing group-level permission checks for resource CRUD operations.
 *
 * Centralizes the duplicated permission logic found in ModelList, ShellList,
 * RetrieverList, TeamList, and BotList components.
 *
 * @param options.scope       - Current scope context (personal/group/all)
 * @param options.groupName   - Current group name (required when scope='group')
 * @param options.groupRoleMap - Map of group namespace to user's role in that group
 * @returns Permission check functions and computed booleans
 */
export function useGroupPermissions({
  scope,
  groupName,
  groupRoleMap,
}: UseGroupPermissionsOptions): GroupPermissions {
  const canEditGroupResource = (namespace: string): boolean => {
    if (!groupRoleMap) return false
    return isEditor(groupRoleMap.get(namespace))
  }

  const canDeleteGroupResource = (namespace: string): boolean => {
    if (!groupRoleMap) return false
    return isManager(groupRoleMap.get(namespace))
  }

  const canCreateInCurrentGroup =
    scope === 'group' && !!groupName && !!groupRoleMap && isManager(groupRoleMap.get(groupName))

  const canCreateInAnyGroup = !!groupRoleMap && Array.from(groupRoleMap.values()).some(isManager)

  return {
    canEditGroupResource,
    canDeleteGroupResource,
    canCreateInCurrentGroup,
    canCreateInAnyGroup,
  }
}
