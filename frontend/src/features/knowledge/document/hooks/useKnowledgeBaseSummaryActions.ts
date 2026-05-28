// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'

import {
  refreshKnowledgeBaseSummary,
  resetKnowledgeBaseSummary,
  updateKnowledgeBaseSummary,
} from '@/apis/knowledge'
import { toast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

interface UseKnowledgeBaseSummaryActionsOptions {
  knowledgeBaseId: number
  onRefresh?: () => void
}

export function useKnowledgeBaseSummaryActions({
  knowledgeBaseId,
  onRefresh,
}: UseKnowledgeBaseSummaryActionsOptions) {
  const { t } = useTranslation('knowledge')
  const [isRetrying, setIsRetrying] = useState(false)
  const isMountedRef = useRef(true)

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const retrySummary = async () => {
    setIsRetrying(true)
    try {
      await refreshKnowledgeBaseSummary(knowledgeBaseId)
      toast({
        description: t('chatPage.summaryRetrying'),
      })
      if (onRefresh) {
        setTimeout(() => {
          if (isMountedRef.current) {
            onRefresh()
          }
        }, 2000)
      }
    } catch (error) {
      console.error('Failed to refresh summary:', error)
      toast({
        variant: 'destructive',
        description: t('chatPage.summaryFailed'),
      })
    } finally {
      if (isMountedRef.current) {
        setIsRetrying(false)
      }
    }
  }

  const saveSummary = async (content: string) => {
    await updateKnowledgeBaseSummary(knowledgeBaseId, content)
    toast({
      description: t('chatPage.summaryEditSaved'),
    })
    onRefresh?.()
  }

  const resetSummary = async () => {
    await resetKnowledgeBaseSummary(knowledgeBaseId)
    toast({
      description: t('chatPage.summaryResetDone'),
    })
    onRefresh?.()
  }

  return {
    isRetrying,
    retrySummary,
    saveSummary,
    resetSummary,
  }
}
