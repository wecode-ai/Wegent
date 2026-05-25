// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Wecode group entity permission API extensions.
 *
 * Adds department-level permission operations for groups (internal-only).
 */

import client from '@/apis/client'
import { updateGroupEntityMemberRole } from '@/apis/groups'
import type {
  DepartmentBatchInput,
  DepartmentBatchResponse,
} from '@wecode/components/department-auth'

export type { GroupEntityMember } from '@/types/group'
export type { DepartmentBatchInput, DepartmentBatchResponse } from '@wecode/components/department-auth'

export const groupPermissionExtensionApi = {
  /**
   * Batch add department permissions for a group.
   *
   * Calls the batch API endpoint for atomic operation.
   */
  batchAddGroupDepartmentPermission: async (
    groupName: string,
    departments: DepartmentBatchInput[],
    _role: string
  ): Promise<DepartmentBatchResponse> => {
    const response = await client.post<DepartmentBatchResponse>(
      `/groups/${encodeURIComponent(groupName)}/entity-members/batch`,
      {
        members: departments.map(dept => ({
          entity_type: 'org_department',
          entity_id: dept.id,
          entity_display_name: dept.displayName,
          role: _role,
        })),
      }
    )

    return response
  },

  /**
   * Update the role of an entity-type member in a group.
   *
   * Delegates to the core groups API.
   */
  updateGroupEntityMemberRole,
}
