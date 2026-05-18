// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo } from 'react'
import { ArrowRightLeft } from 'lucide-react'
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
import { Spinner } from '@/components/ui/spinner'
import { listKnowledgeBases } from '@/apis/knowledge'
import type { KnowledgeBase } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

interface TransferToKbDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Number of selected documents to transfer */
  selectedDocumentCount: number
  /** Number of selected folders to transfer */
  selectedFolderCount: number
  /** Current knowledge base ID (excluded from target list) */
  currentKnowledgeBaseId: number
  /** Callback when user confirms the transfer */
  onConfirm: (targetKbId: number) => Promise<void>
  /** Whether the transfer operation is in progress */
  isSubmitting?: boolean
}

export function TransferToKbDialog({
  open,
  onOpenChange,
  selectedDocumentCount,
  selectedFolderCount,
  currentKnowledgeBaseId,
  onConfirm,
  isSubmitting = false,
}: TransferToKbDialogProps) {
  const { t } = useTranslation('knowledge')
  const [targetKbId, setTargetKbId] = useState<string>('')
  const [personalKbs, setPersonalKbs] = useState<KnowledgeBase[]>([])
  const [loadingKbs, setLoadingKbs] = useState(false)

  // Fetch personal KBs when dialog opens
  useEffect(() => {
    if (open) {
      setLoadingKbs(true)
      listKnowledgeBases('personal')
        .then(res => {
          setPersonalKbs(
            res.items.filter(kb => kb.id !== currentKnowledgeBaseId)
          )
        })
        .catch(() => {
          setPersonalKbs([])
        })
        .finally(() => setLoadingKbs(false))
    }
  }, [open, currentKnowledgeBaseId])

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setTargetKbId('')
    }
    onOpenChange(newOpen)
  }

  const handleTransfer = async () => {
    if (!targetKbId) return
    await onConfirm(Number(targetKbId))
  }

  const totalCount = selectedDocumentCount + selectedFolderCount

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5 text-primary" />
            {t('document.document.batch.transferTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <p className="text-sm text-text-secondary">
            {t('document.document.batch.transferHint', {
              docCount: selectedDocumentCount,
              folderCount: selectedFolderCount,
            })}
          </p>

          {/* Target KB selector */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              {t('document.document.batch.selectTargetKb')}
            </Label>
            {loadingKbs ? (
              <div className="flex items-center justify-center py-3">
                <Spinner />
              </div>
            ) : personalKbs.length === 0 ? (
              <p className="text-sm text-text-muted py-2">
                {t('document.document.batch.noOtherKbs')}
              </p>
            ) : (
              <Select value={targetKbId} onValueChange={setTargetKbId}>
                <SelectTrigger className="h-9" data-testid="transfer-target-kb-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {personalKbs.map(kb => (
                    <SelectItem key={kb.id} value={String(kb.id)}>
                      {kb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
            className="h-11 min-w-[44px]"
            data-testid="transfer-cancel-button"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleTransfer}
            disabled={isSubmitting || !targetKbId || loadingKbs || personalKbs.length === 0}
            className="h-11 min-w-[44px]"
            data-testid="transfer-confirm-button"
          >
            {isSubmitting
              ? t('document.document.batch.transferring')
              : t('common:actions.move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}