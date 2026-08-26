// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import type { ScriptDetail } from './types'

export const scriptApi = {
  getScript(scriptId: number): Promise<ScriptDetail> {
    return apiClient.get<ScriptDetail>(`/aigc-video/api/v2/scripts/${scriptId}`)
  },

  updateDraftScript(
    scriptId: number,
    data: { draft_content: string }
  ): Promise<{ script_id: number; message: string; update_time: string }> {
    return apiClient.put(`/aigc-video/api/v2/scripts/${scriptId}/draft`, data)
  },
}
