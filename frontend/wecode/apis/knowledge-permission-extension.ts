// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Wecode knowledge permission API extensions.
 *
 * Adds department-level permission operations that are internal-only.
 */

import client from '@/apis/client'
import type { PermissionResponse } from '@/types/knowledge'

export const knowledgePermissionExtensionApi = {
  /**
   * Add permission for an org_department (ERP department).
   */
  addDepartmentPermission: async (
    kbId: number,
    departmentId: string,
    role: string,
    entityDisplayName?: string
  ): Promise<PermissionResponse> => {
    const response = await client.post<PermissionResponse>(`/share/KnowledgeBase/${kbId}/members`, {
      user_id: 0,
      role,
      entity_type: 'org_department',
      entity_id: departmentId,
      entity_display_name: entityDisplayName,
    })
    return response
  },
}
