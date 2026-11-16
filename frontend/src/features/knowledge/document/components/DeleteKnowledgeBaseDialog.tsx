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
import type { KnowledgeBase } from '@/types/knowledge'

interface DeleteKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase | null
  onConfirm: (continueOnExternalFailure?: boolean) => Promise<void>
  loading?: boolean
}

export function DeleteKnowledgeBaseDialog({
  open,
  onOpenChange,
  knowledgeBase,
  onConfirm,
  loading,
}: DeleteKnowledgeBaseDialogProps) {
  const { t } = useTranslation('knowledge')
  const { error, canContinue, confirm, reset } = useDeleteConfirmation(
    open,
    knowledgeBase?.id,
    onConfirm
  )

  const hasDocuments = !!(knowledgeBase && knowledgeBase.document_count > 0)
  const isCodeWiki = knowledgeBase?.kb_type === 'code_wiki'
  const blocksDeletion = hasDocuments && !isCodeWiki

  const handleConfirm = async () => {
    if (blocksDeletion) {
      return
    }
    await confirm()
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      reset()
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[90dvh] w-[calc(100%_-_1rem)] min-w-0 grid-cols-[minmax(0,1fr)] overflow-y-auto"
        closeButtonProps={{
          className: 'right-2 top-2 flex h-11 w-11 items-center justify-center',
          'data-testid': 'close-delete-kb',
        }}
      >
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
            <p className="break-words font-medium text-text-primary [overflow-wrap:anywhere]">
              {knowledgeBase.name}
            </p>
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
          <Button
            data-testid="cancel-delete-kb"
            className="min-h-11"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            className="min-h-11"
            variant="primary"
            data-testid={canContinue ? 'continue-delete-kb' : 'confirm-delete-kb'}
            onClick={handleConfirm}
            disabled={loading || blocksDeletion}
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
