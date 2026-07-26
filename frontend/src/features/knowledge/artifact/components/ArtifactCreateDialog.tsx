// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { FileText, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeArtifactCreate, KnowledgeArtifactType } from '@/types/knowledge-artifact'

interface ArtifactCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedDocumentIds: number[]
  onCreate: (request: KnowledgeArtifactCreate) => Promise<void>
}

export function ArtifactCreateDialog({
  open,
  onOpenChange,
  selectedDocumentIds,
  onCreate,
}: ArtifactCreateDialogProps) {
  const { t } = useTranslation('knowledge')
  const [artifactType, setArtifactType] = useState<KnowledgeArtifactType>('briefing')
  const [title, setTitle] = useState('')
  const [instruction, setInstruction] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (!open) {
      setArtifactType('briefing')
      setTitle('')
      setInstruction('')
      setIsSubmitting(false)
    }
  }, [open])

  const handleCreate = async () => {
    setIsSubmitting(true)
    try {
      await onCreate({
        artifact_type: artifactType,
        document_ids: selectedDocumentIds,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
      })
      onOpenChange(false)
    } catch {
      // The parent displays the API error. Keep the dialog open for retry.
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="artifact-create-dialog">
        <DialogHeader>
          <DialogTitle>{t('artifact.createTitle')}</DialogTitle>
          <DialogDescription>{t('artifact.createDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className={`rounded-lg border p-4 text-left transition-colors ${
                artifactType === 'briefing'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-hover'
              }`}
              onClick={() => setArtifactType('briefing')}
              data-testid="artifact-type-briefing"
            >
              <FileText className="mb-2 h-5 w-5 text-primary" />
              <div className="font-medium">{t('artifact.type.briefing')}</div>
              <div className="mt-1 text-xs text-text-secondary">
                {t('artifact.type.briefingHint')}
              </div>
            </button>
            <button
              type="button"
              className={`rounded-lg border p-4 text-left transition-colors ${
                artifactType === 'mind_map'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-hover'
              }`}
              onClick={() => setArtifactType('mind_map')}
              data-testid="artifact-type-mind-map"
            >
              <Network className="mb-2 h-5 w-5 text-primary" />
              <div className="font-medium">{t('artifact.type.mindMap')}</div>
              <div className="mt-1 text-xs text-text-secondary">
                {t('artifact.type.mindMapHint')}
              </div>
            </button>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium" htmlFor="artifact-title">
              {t('artifact.titleLabel')}
            </label>
            <Input
              id="artifact-title"
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder={t('artifact.titlePlaceholder')}
              maxLength={255}
              data-testid="artifact-title-input"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium" htmlFor="artifact-instruction">
              {t('artifact.instructionLabel')}
            </label>
            <Textarea
              id="artifact-instruction"
              value={instruction}
              onChange={event => setInstruction(event.target.value)}
              placeholder={t('artifact.instructionPlaceholder')}
              rows={3}
              maxLength={10000}
              data-testid="artifact-instruction-input"
            />
          </div>
          <p className="text-xs text-text-secondary">
            {selectedDocumentIds.length > 0
              ? t('artifact.selectedDocuments', { count: selectedDocumentIds.length })
              : t('artifact.allDocuments')}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="artifact-create-cancel"
          >
            {t('artifact.cancel')}
          </Button>
          <Button
            onClick={() => void handleCreate()}
            disabled={isSubmitting}
            data-testid="artifact-create-submit"
          >
            {isSubmitting ? t('artifact.creating') : t('artifact.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
