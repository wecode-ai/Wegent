// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'

export type HimalayaMailDomain = '@staff.sina.com.cn' | '@staff.weibo.com'

export interface HimalayaMailConfigRequest {
  account_prefix: string
  email_domain: HimalayaMailDomain
  password: string
}

export interface HimalayaMailConfigResponse {
  success: boolean
  message: string
  account_name?: string | null
  config_path?: string | null
}

export const himalayaMailApis = {
  async createConfig(
    deviceId: string,
    payload: HimalayaMailConfigRequest
  ): Promise<HimalayaMailConfigResponse> {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/himalaya-mail-config`, payload)
  },
}
