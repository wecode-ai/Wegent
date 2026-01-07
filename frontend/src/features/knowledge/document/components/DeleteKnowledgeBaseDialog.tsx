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

  // Check if knowledge base has documents
  const hasDocuments = !!(knowledgeBase && knowledgeBase.document_count > 0)

  const handleConfirm = async () => {
    // Prevent deletion if there are documents
    if (hasDocuments) {
      return
    }
    try {
      await onConfirm()
    } catch {
      // Error handled by parent
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.knowledgeBase.delete')}</DialogTitle>
          <DialogDescription>
            {hasDocuments
              ? t('knowledge:document.knowledgeBase.cannotDeleteWithDocuments')
              : t('knowledge:document.knowledgeBase.confirmDelete')}
          </DialogDescription>
        </DialogHeader>
        {knowledgeBase && (
          <div className="py-4">
            <p className="text-text-primary font-medium">{knowledgeBase.name}</p>
            {hasDocuments && (
              <p className="text-sm text-error mt-2">
                {t('knowledge:document.knowledgeBase.deleteWarning', {
                  count: knowledgeBase.document_count,
                })}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={loading || hasDocuments}>
            {loading ? t('common:actions.deleting') : t('common:actions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
