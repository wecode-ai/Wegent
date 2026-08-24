// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import type { EntityListResponse } from './types'

export const entityApis = {
  listEntities(taskId: number): Promise<EntityListResponse> {
    return apiClient.get(`/aigc-video/api/v2/entities?task_id=${taskId}`)
  },
}
