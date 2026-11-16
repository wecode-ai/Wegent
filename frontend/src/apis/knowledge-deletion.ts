// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from './client'

export interface ContentDeletionOutcome {
  content_deleted: boolean
  index_cleanup: 'confirmed' | 'unconfirmed' | 'not_applicable'
  error_code: string | null
  can_continue: boolean
}

export interface BatchDocumentDeletionOutcome extends ContentDeletionOutcome {
  document_id: number
}

export function isContinuableDeletionError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 502) return false
  const detail = error.detail
  return (
    error.errorCode === 'external_engine_unavailable' &&
    typeof detail === 'object' &&
    detail !== null &&
    'code' in detail &&
    detail.code === 'external_engine_unavailable' &&
    'can_continue' in detail &&
    detail.can_continue === true
  )
}
