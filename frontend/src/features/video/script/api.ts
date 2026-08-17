// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import type { ScriptDetail } from './types'

export const scriptApi = {
  getScript(scriptId: number): Promise<ScriptDetail> {
    return apiClient.get(`/aigc-video/api/v2/scripts/${scriptId}`)
  },
}
