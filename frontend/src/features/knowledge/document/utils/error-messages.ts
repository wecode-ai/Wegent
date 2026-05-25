// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from '@/apis/client'
import type { TFunction } from 'i18next'

const FOLDER_DEPTH_EXCEEDED_MESSAGE =
  'Folder hierarchy exceeds the maximum depth of 4 levels under a knowledge base'
const DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE =
  'Documents can only be placed within the 4th folder level under a knowledge base or above'
const FOLDER_DEPTH_EXCEEDED_ERROR_CODE = 'KNOWLEDGE_FOLDER_DEPTH_EXCEEDED'
const DOCUMENT_FOLDER_DEPTH_EXCEEDED_ERROR_CODE = 'KNOWLEDGE_DOCUMENT_TARGET_FOLDER_DEPTH_EXCEEDED'

export function mapKnowledgeDocumentErrorMessage(
  error: unknown,
  t: TFunction<'knowledge'>,
  fallbackKey: string
): string {
  if (!(error instanceof Error)) {
    return t(fallbackKey)
  }

  if (error instanceof ApiError) {
    if (error.errorCode === FOLDER_DEPTH_EXCEEDED_ERROR_CODE) {
      return t('document.folder.depthExceeded')
    }

    if (error.errorCode === DOCUMENT_FOLDER_DEPTH_EXCEEDED_ERROR_CODE) {
      return t('document.folder.documentPlacementDepthExceeded')
    }
  }

  if (error.message === FOLDER_DEPTH_EXCEEDED_MESSAGE) {
    return t('document.folder.depthExceeded')
  }

  if (error.message === DOCUMENT_FOLDER_DEPTH_EXCEEDED_MESSAGE) {
    return t('document.folder.documentPlacementDepthExceeded')
  }

  return error.message
}
