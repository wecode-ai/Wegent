// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DocumentProcessingError } from '@/types/knowledge'

const ERROR_TRANSLATION_KEYS: Record<string, string> = {
  model_quota_exhausted: 'modelQuotaExhausted',
  model_permission_denied: 'modelPermissionDenied',
  conversion_timeout: 'conversionTimeout',
  conversion_service_unavailable: 'conversionServiceUnavailable',
  conversion_lock_timeout: 'conversionLockTimeout',
  conversion_failed: 'conversionFailed',
  indexing_timeout: 'indexingTimeout',
  indexing_failed: 'indexingFailed',
  index_lock_timeout: 'indexLockTimeout',
  index_dispatch_failed: 'indexDispatchFailed',
  processing_failed: 'processingFailed',
}

export function getProcessingErrorMessage(
  error: DocumentProcessingError,
  translate: (key: string) => string
): string {
  // Known codes are localized by the client. The backend's safe message is a
  // rolling-upgrade fallback for codes this frontend version does not know.
  const translationKey = ERROR_TRANSLATION_KEYS[error.code]
  return translationKey
    ? translate(`knowledge:document.document.processingError.codes.${translationKey}`)
    : error.message
}
