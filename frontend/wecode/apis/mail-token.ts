// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Mail token API services.
 *
 * Provides methods for exchanging, querying, and deleting
 * company mail tokens via KMS integration.
 */

import { apiClient } from '@/apis/client'

/**
 * Response from mail token status query
 */
export interface MailTokenStatusResponse {
  configured: boolean
}

/**
 * Mail token API services
 */
export const mailTokenApis = {
  /**
   * Exchange a client_token for a mail_token and save it.
   *
   * @param clientToken - Token obtained from DingTalk bot
   */
  async save(clientToken: string): Promise<{ message: string }> {
    return apiClient.post('/wecode/mail/token', { client_token: clientToken })
  },

  /**
   * Check whether a mail token is configured.
   */
  async getStatus(): Promise<MailTokenStatusResponse> {
    return apiClient.get('/wecode/mail/token')
  },

  /**
   * Delete the configured mail token.
   */
  async delete(): Promise<{ message: string }> {
    return apiClient.delete('/wecode/mail/token')
  },
}
