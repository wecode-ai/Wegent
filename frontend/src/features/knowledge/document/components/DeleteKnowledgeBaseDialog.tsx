// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeBase } from '@/types/knowledge'
import { useState } from 'react'

interface DeleteKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase | null
  onConfirm: () => Promise<void>
  loading?: boolean
}

export function DeleteKnowledgeBaseDialog({
  open,
  onOpenChange,
  knowledgeBase,
  onConfirm,
  loading,
}: DeleteKnowledgeBaseDialogProps) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)

  const hasDocuments = !!(knowledgeBase && knowledgeBase.document_count > 0)
  const isCodeWiki = knowledgeBase?.kb_type === 'code_wiki'
  const blocksDeletion = hasDocuments && !isCodeWiki

  const handleConfirm = async () => {
    if (blocksDeletion) {
      return
    }
    setError(null)
    try {
      await onConfirm()
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t('knowledge:document.knowledgeBase.deleteFailed')
      )
    }
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setError(null)
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.knowledgeBase.delete')}</DialogTitle>
          <DialogDescription>
            {blocksDeletion
              ? t('knowledge:document.knowledgeBase.cannotDeleteWithDocuments')
              : isCodeWiki
                ? t('knowledge:document.knowledgeBase.deleteCodeWikiWarning')
                : t('knowledge:document.knowledgeBase.confirmDelete')}
          </DialogDescription>
        </DialogHeader>
        {knowledgeBase && (
          <div className="py-4">
            <p className="text-text-primary font-medium">{knowledgeBase.name}</p>
            {blocksDeletion && (
              <p className="text-sm text-error mt-2">
                {t('knowledge:document.knowledgeBase.deleteWarning', {
                  count: knowledgeBase.document_count,
                })}
              </p>
            )}
            {error && (
              <p className="text-sm text-error mt-2" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={loading}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={loading || blocksDeletion}
          >
            {loading ? t('common:actions.deleting') : t('common:actions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
