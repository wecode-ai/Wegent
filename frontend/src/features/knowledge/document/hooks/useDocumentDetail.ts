// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback } from 'react'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import type { DocumentDetailResponse } from '@/types/knowledge'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'

interface UseDocumentDetailOptions {
  kbId: number
  docId: number
  includeContent?: boolean
  includeSummary?: boolean
  enabled?: boolean
}

export function useDocumentDetail({
  kbId,
  docId,
  includeContent = true,
  includeSummary = true,
  enabled = true,
}: UseDocumentDetailOptions) {
  const { t } = useTranslation('knowledge')
  const [detail, setDetail] = useState<DocumentDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const fetchDetail = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await knowledgeBaseApi.getDocumentDetail(kbId, docId, {
        includeContent,
        includeSummary,
      })
      setDetail(response)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load document detail'
      setError(errorMessage)
      toast.error(t('document.detail.content.error'))
    } finally {
      setLoading(false)
    }
  }, [kbId, docId, includeContent, includeSummary, t])

  const refreshSummary = useCallback(async () => {
    try {
      setRefreshing(true)
      await knowledgeBaseApi.refreshDocumentSummary(kbId, docId)
      toast.success(t('document.detail.summary.refresh') + ' ' + t('common:actions.success'))
      // Refresh the detail after triggering summary generation
      await fetchDetail()
    } catch {
      toast.error(t('document.detail.summary.refresh') + ' ' + t('common:actions.failed'))
    } finally {
      setRefreshing(false)
    }
  }, [kbId, docId, fetchDetail, t])

  useEffect(() => {
    if (enabled) {
      fetchDetail()
    }
  }, [fetchDetail, enabled])

  return {
    detail,
    loading,
    error,
    refreshing,
    refresh: fetchDetail,
    refreshSummary,
  }
}
