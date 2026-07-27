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
import { ArtifactSourceSelector, type ArtifactSourceScope } from './ArtifactSourceSelector'

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
  const [draftScope, setDraftScope] = useState<ArtifactSourceScope>({ mode: 'all' })

  useEffect(() => {
    if (!open) return
    setDraftScope(
      selectedDocumentIds.length > 0
        ? { mode: 'selected', documentIds: new Set(selectedDocumentIds) }
        : { mode: 'all' }
    )
  }, [open, selectedDocumentIds])

  const handleApply = () => {
    onApply(draftScope.mode === 'all' ? [] : Array.from(draftScope.documentIds))
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
            scope={draftScope}
            availableDocumentCount={availableDocumentCount}
            active={open}
            onScopeChange={setDraftScope}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('artifact.cancel')}
          </Button>
          <Button variant="primary" onClick={handleApply} data-testid="artifact-source-apply">
            {t('artifact.sourceDialog.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
