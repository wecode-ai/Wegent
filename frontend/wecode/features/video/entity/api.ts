// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import type { EntityListResponse } from './types'

export const entityApis = {
  listEntities(taskId: number, options?: { shareToken?: string }): Promise<EntityListResponse> {
    const query = new URLSearchParams({ task_id: String(taskId) })
    if (options?.shareToken) query.set('share_token', options.shareToken)
    return apiClient.get(`/aigc-video/api/v2/entities?${query}`)
  },
}
