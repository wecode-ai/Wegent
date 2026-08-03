// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'

export interface DocumentProtectionContext {
  protected: boolean
  watermark_required: boolean
  copy_allowed: boolean
  product_download_allowed: boolean
  preview_mode: 'default' | 'protected'
  watermark?: {
    display_name: string
    employee_id: string
  }
}

export function getDocumentProtection(knowledgeBaseId: number): Promise<DocumentProtectionContext> {
  return apiClient.get(`/wecode/knowledge-bases/${knowledgeBaseId}/document-protection`)
}
