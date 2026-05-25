// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Wecode knowledge permission API extensions.
 *
 * Adds department-level permission operations that are internal-only.
 */

import client from '@/apis/client'
import type {
  DepartmentBatchInput,
  DepartmentBatchResponse,
} from '@wecode/components/department-auth'

export type { DepartmentBatchInput, DepartmentBatchResponse } from '@wecode/components/department-auth'

export const knowledgePermissionExtensionApi = {
  /**
   * Batch add permissions for multiple org_department entities in one request.
   *
   * Reuses the open-source /share/{type}/{id}/members/batch endpoint, which
   * already supports arbitrary entity_type values (verified against the
   * ResourceMemberCreate schema). Returns per-entity success / failure so
   * the caller can keep failed departments selected for retry.
   */
  batchAddDepartmentPermission: async (
    kbId: number,
    departments: DepartmentBatchInput[],
    role: string
  ): Promise<DepartmentBatchResponse> => {
    const response = await client.post<DepartmentBatchResponse>(
      `/share/KnowledgeBase/${kbId}/members/batch`,
      {
        members: departments.map(d => ({
          user_id: 0,
          role,
          entity_type: 'org_department',
          entity_id: d.id,
          entity_display_name: d.displayName,
        })),
      }
    )
    return response
  },
}
