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
import { toast } from '@/hooks/use-toast'

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
/**
 * Group knowledge bases by their namespace for display
 * - namespace === 'default' -> personal KB
 * - other namespaces -> team/organization KB (we treat them as "team" for simplicity)
 */
function groupKnowledgeBases(kbs: KnowledgeBase[]) {
  const personal: KnowledgeBase[] = []
  const team: KnowledgeBase[] = []

  for (const kb of kbs) {
    // namespace === 'default' means personal KB
    if (kb.namespace === 'default') {
      personal.push(kb)
    } else {
      // All other namespaces are treated as team/org KBs
      team.push(kb)
    }
  }

  return { personal, team }
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
  const [allKbs, setAllKbs] = useState<KnowledgeBase[]>([])
  const [loadingKbs, setLoadingKbs] = useState(false)

  // Fetch all KBs when dialog opens (personal, team, organization)
  useEffect(() => {
    if (open) {
      setLoadingKbs(true)
      listKnowledgeBases('all')
        .then(res => {
          setAllKbs(res.items.filter(kb => kb.id !== currentKnowledgeBaseId))
        })
        .catch(() => {
          setAllKbs([])
          toast({
            title: t('document.document.batch.transferFailed'),
            variant: 'destructive',
          })
        })
        .finally(() => setLoadingKbs(false))
    }
  }, [open, currentKnowledgeBaseId])

  // Clear targetKbId when dialog closes (handles both UI interaction and parent prop change)
  useEffect(() => {
    if (!open) {
      setTargetKbId('')
    }
  }, [open])

  // Group KBs by type
  const groupedKbs = useMemo(() => groupKnowledgeBases(allKbs), [allKbs])
  const hasKbs = allKbs.length > 0

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
            ) : !hasKbs ? (
              <p className="text-sm text-text-muted py-2">
                {t('document.document.batch.noOtherKbs')}
              </p>
            ) : (
              <Select value={targetKbId} onValueChange={setTargetKbId}>
                <SelectTrigger className="h-9" data-testid="transfer-target-kb-select">
                  <SelectValue placeholder={t('document.document.batch.selectTargetKb')} />
                </SelectTrigger>
                <SelectContent>
                  {/* Personal KBs */}
                  {groupedKbs.personal.length > 0 && (
                    <>
                      <SelectItem
                        value="__personal_group__"
                        disabled
                        className="font-semibold text-text-secondary"
                      >
                        {t('knowledgeBase.personal')}
                      </SelectItem>
                      {groupedKbs.personal.map(kb => (
                        <SelectItem key={kb.id} value={String(kb.id)}>
                          {kb.name}
                        </SelectItem>
                      ))}
                    </>
                  )}

                  {/* Team/Organization KBs */}
                  {groupedKbs.team.length > 0 && (
                    <>
                      <SelectItem
                        value="__team_group__"
                        disabled
                        className="font-semibold text-text-secondary"
                      >
                        {t('knowledgeBase.team')}
                      </SelectItem>
                      {groupedKbs.team.map(kb => (
                        <SelectItem key={kb.id} value={String(kb.id)}>
                          {kb.namespace !== 'default' ? `${kb.namespace} / ${kb.name}` : kb.name}
                        </SelectItem>
                      ))}
                    </>
                  )}
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
            disabled={isSubmitting || !targetKbId || loadingKbs || !hasKbs}
            className="h-11 min-w-[44px]"
            data-testid="transfer-confirm-button"
          >
            {isSubmitting
              ? t('document.document.batch.transferring')
              : t('document.document.batch.transfer')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
