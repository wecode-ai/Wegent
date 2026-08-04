// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getProcessingErrorMessage } from '@/features/knowledge/document/utils/processing-error'
import type { DocumentProcessingError } from '@/types/knowledge'

function createError(code: string, message = 'fallback'): DocumentProcessingError {
  return {
    stage: 'conversion',
    code,
    message,
    retryable: false,
    generation: 1,
    occurred_at: '2026-01-01T00:00:00Z',
  }
}

describe('getProcessingErrorMessage', () => {
  const translate = (key: string) => `translated:${key}`

  it.each([
    ['model_quota_exhausted', 'modelQuotaExhausted'],
    ['model_permission_denied', 'modelPermissionDenied'],
    ['multimodal_empty_response', 'multimodalEmptyResponse'],
    ['conversion_timeout', 'conversionTimeout'],
    ['indexing_timeout', 'indexingTimeout'],
  ])('localizes known code %s', (code, translationKey) => {
    expect(getProcessingErrorMessage(createError(code), translate)).toBe(
      `translated:knowledge:document.document.processingError.codes.${translationKey}`
    )
  })

  it('uses the safe backend message for an unknown code', () => {
    expect(getProcessingErrorMessage(createError('future_error', 'safe fallback'), translate)).toBe(
      'safe fallback'
    )
  })
})
