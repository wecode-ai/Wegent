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
import { useDeleteConfirmation } from '../hooks/useDeleteConfirmation'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeDocument } from '@/types/knowledge'

interface DeleteDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: KnowledgeDocument | null
  onConfirm: (continueOnExternalFailure?: boolean) => Promise<void>
  loading?: boolean
}

export function DeleteDocumentDialog({
  open,
  onOpenChange,
  document,
  onConfirm,
  loading,
}: DeleteDocumentDialogProps) {
  const { t } = useTranslation('knowledge')

  const { error, canContinue, confirm, reset } = useDeleteConfirmation(
    open,
    document?.id,
    onConfirm
  )
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset()
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.document.delete')}</DialogTitle>
          <DialogDescription>{t('knowledge:document.document.confirmDelete')}</DialogDescription>
        </DialogHeader>
        {document && (
          <div className="py-4">
            <p className="text-text-primary font-medium">{document.name}</p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            className="min-h-11"
            variant="outline"
            data-testid="cancel-delete-document"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            data-testid={canContinue ? 'continue-delete-document' : 'confirm-delete-document'}
            className="min-h-11"
            variant="primary"
            onClick={confirm}
            disabled={loading}
          >
            {loading
              ? t('common:actions.deleting')
              : canContinue
                ? t('knowledge:document.deletion.continue')
                : t('common:actions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
