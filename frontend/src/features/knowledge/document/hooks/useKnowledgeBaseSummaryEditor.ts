// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'

import type { KnowledgeBase } from '@/types/knowledge'

import { useKnowledgeBaseSummaryActions } from './useKnowledgeBaseSummaryActions'

interface UseKnowledgeBaseSummaryEditorOptions {
  knowledgeBase: KnowledgeBase
  onRefresh?: () => void
}

export function useKnowledgeBaseSummaryEditor({
  knowledgeBase,
  onRefresh,
}: UseKnowledgeBaseSummaryEditorOptions) {
  const [isEditOpen, setIsEditOpen] = useState(false)
  const { isRetrying, retrySummary, saveSummary, resetSummary } = useKnowledgeBaseSummaryActions({
    knowledgeBaseId: knowledgeBase.id,
    onRefresh,
  })

  return {
    isRetrying,
    retrySummary,
    openEditor: () => setIsEditOpen(true),
    editorDialogProps: {
      open: isEditOpen,
      onOpenChange: setIsEditOpen,
      knowledgeBase,
      onSave: saveSummary,
      onReset: resetSummary,
    },
  }
}
