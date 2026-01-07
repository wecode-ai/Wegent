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
import type { KnowledgeDocument } from '@/types/knowledge'

interface DeleteDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: KnowledgeDocument | null
  onConfirm: () => Promise<void>
  loading?: boolean
}

export function DeleteDocumentDialog({
  open,
  onOpenChange,
  document,
  onConfirm,
  loading,
}: DeleteDocumentDialogProps) {
  const { t } = useTranslation()

  const handleConfirm = async () => {
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
          <DialogTitle>{t('knowledge:document.document.delete')}</DialogTitle>
          <DialogDescription>{t('knowledge:document.document.confirmDelete')}</DialogDescription>
        </DialogHeader>
        {document && (
          <div className="py-4">
            <p className="text-text-primary font-medium">{document.name}</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={loading}>
            {loading ? t('common:actions.deleting') : t('common:actions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
