// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'

interface MoveDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Name of the document being moved */
  documentName: string
  /** Flat list of folder options */
  folders: Array<{ id: number; name: string; depth: number }>
  /** Current folder ID of the document (0 = root) */
  currentFolderId?: number
  /** Callback when user confirms the move */
  onConfirm: (targetFolderId: number) => Promise<void>
  /** Whether the move operation is in progress */
  isSubmitting?: boolean
}

export function MoveDocumentDialog({
  open,
  onOpenChange,
  documentName,
  folders,
  currentFolderId = 0,
  onConfirm,
  isSubmitting = false,
}: MoveDocumentDialogProps) {
  const { t } = useTranslation('knowledge')
  const [targetFolderId, setTargetFolderId] = useState<string>(String(currentFolderId))

  const handleConfirm = async () => {
    await onConfirm(Number(targetFolderId))
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Reset to current folder when closing
      setTargetFolderId(String(currentFolderId))
    }
    onOpenChange(open)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('document.folder.moveDocument')}</DialogTitle>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <p className="text-sm text-text-secondary">
            {t('document.folder.moveDocumentHint', { name: documentName })}
          </p>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">{t('document.folder.selectFolder')}</Label>
            <Select value={targetFolderId} onValueChange={setTargetFolderId}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">
                  {t('document.folder.rootLevel')}
                  {currentFolderId === 0 ? ` (${t('document.folder.current')})` : ''}
                </SelectItem>
                {folders.map(folder => (
                  <SelectItem key={folder.id} value={String(folder.id)}>
                    {'\u00A0'.repeat(folder.depth * 2)}
                    {folder.name}
                    {folder.id === currentFolderId ? ` (${t('document.folder.current')})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={isSubmitting || Number(targetFolderId) === currentFolderId}
          >
            {t('common:actions.move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
