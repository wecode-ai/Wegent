// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { ArtifactSourceSelector, type ArtifactSourceMode } from './ArtifactSourceSelector'

interface ArtifactSourceDialogProps {
  knowledgeBaseId: number
  open: boolean
  selectedDocumentIds: number[]
  availableDocumentCount: number | null
  onOpenChange: (open: boolean) => void
  onApply: (documentIds: number[]) => void
}

export function ArtifactSourceDialog({
  knowledgeBaseId,
  open,
  selectedDocumentIds,
  availableDocumentCount,
  onOpenChange,
  onApply,
}: ArtifactSourceDialogProps) {
  const { t } = useTranslation('knowledge')
  const [mode, setMode] = useState<ArtifactSourceMode>('all')
  const [draftIds, setDraftIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!open) return
    setMode(selectedDocumentIds.length > 0 ? 'selected' : 'all')
    setDraftIds(new Set(selectedDocumentIds))
  }, [open, selectedDocumentIds])

  const handleApply = () => {
    onApply(mode === 'all' ? [] : Array.from(draftIds))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[80vh] flex-col sm:max-w-2xl"
        data-testid="artifact-source-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('artifact.sourceDialog.title')}</DialogTitle>
          <DialogDescription>{t('artifact.sourceDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto">
          <ArtifactSourceSelector
            knowledgeBaseId={knowledgeBaseId}
            mode={mode}
            selectedDocumentIds={draftIds}
            availableDocumentCount={availableDocumentCount}
            active={open}
            onModeChange={setMode}
            onSelectedDocumentIdsChange={setDraftIds}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('artifact.cancel')}
          </Button>
          <Button
            onClick={handleApply}
            disabled={mode === 'selected' && draftIds.size === 0}
            data-testid="artifact-source-apply"
          >
            {t('artifact.sourceDialog.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
