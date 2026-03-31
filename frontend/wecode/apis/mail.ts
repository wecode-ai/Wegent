// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'

export type MailDomain = '@staff.sina.com.cn' | '@staff.weibo.com'

export interface MailConfigRequest {
  task_id: number
  account_prefix: string
  email_domain: MailDomain
  password: string
}

export interface MailConfigResponse {
  success: boolean
  message: string
  account_name?: string | null
  config_path?: string | null
}

export const mailApis = {
  async createConfig(deviceId: string, payload: MailConfigRequest): Promise<MailConfigResponse> {
    return apiClient.post(`/devices/${encodeURIComponent(deviceId)}/mail-config`, payload)
  },
}
