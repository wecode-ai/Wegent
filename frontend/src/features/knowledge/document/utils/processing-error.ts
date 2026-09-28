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
  conversion_configuration_error: 'conversionConfigurationError',
  multimodal_empty_response: 'multimodalEmptyResponse',
  multimodal_model_unavailable: 'multimodalModelUnavailable',
  multimodal_file_too_large: 'multimodalFileTooLarge',
  indexing_timeout: 'indexingTimeout',
  indexing_failed: 'indexingFailed',
  index_lock_timeout: 'indexLockTimeout',
  index_dispatch_failed: 'indexDispatchFailed',
  processing_failed: 'processingFailed',
  external_import_failed: 'externalImportFailed',
  external_source_missing: 'externalSourceMissing',
  external_source_unavailable: 'externalSourceUnavailable',
}

export function getProcessingErrorMessage(
  error: DocumentProcessingError,
  translate: (key: string) => string
): string {
  // Import providers already reduce upstream failures to user-safe text. Keep
  // that concrete reason (for example, a Wiki connection failure) instead of
  // replacing it with the generic localized import message.
  if (error.code === 'external_import_failed') return error.message

  // Known codes are localized by the client. The backend's safe message is a
  // rolling-upgrade fallback for codes this frontend version does not know.
  const translationKey = ERROR_TRANSLATION_KEYS[error.code]
  return translationKey
    ? translate(`knowledge:document.document.processingError.codes.${translationKey}`)
    : error.message
}
