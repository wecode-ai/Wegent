// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback } from 'react'

import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeDocument } from '@/types/knowledge'

import { isExternalSourceUnavailable } from '../utils/documentUtils'

/**
 * Label of the DingTalk manual sync control, which doubles as retry.
 *
 * Every surface that exposes the entry derives the label the same way so the
 * list, the table and the document preview never disagree.
 */
export function useDingtalkSyncLabel() {
  const { t } = useTranslation('knowledge')

  return useCallback(
    (document: KnowledgeDocument, busy: boolean): string => {
      if (busy) return t('document.document.syncing')
      // The control doubles as the retry entry: a copy whose index failed needs
      // the same source refresh again, so it must not read as a first-time
      // action.
      const retryable = isExternalSourceUnavailable(document) || document.index_status === 'failed'
      return retryable ? t('document.document.syncRetry') : t('document.document.syncNow')
    },
    [t]
  )
}
