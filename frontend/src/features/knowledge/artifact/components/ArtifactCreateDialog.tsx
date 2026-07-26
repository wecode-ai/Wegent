// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Database, FileText, Network, Settings2 } from 'lucide-react'
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
  artifactType: KnowledgeArtifactType
  selectedDocumentIds: number[]
  knowledgeBaseDocumentCount: number
  onAdjustSources: () => void
  onCreate: (request: KnowledgeArtifactCreate) => Promise<void>
}

export function ArtifactCreateDialog({
  open,
  onOpenChange,
  artifactType,
  selectedDocumentIds,
  knowledgeBaseDocumentCount,
  onAdjustSources,
  onCreate,
}: ArtifactCreateDialogProps) {
  const { t } = useTranslation('knowledge')
  const [title, setTitle] = useState('')
  const [instruction, setInstruction] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

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
          <DialogTitle>{t(`artifact.action.${artifactType}`)}</DialogTitle>
          <DialogDescription>{t('artifact.createDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              {artifactType === 'mind_map' ? (
                <Network className="h-5 w-5" />
              ) : (
                <FileText className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {t(`artifact.type.${artifactType === 'mind_map' ? 'mindMap' : 'briefing'}`)}
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                {t(`artifact.type.${artifactType === 'mind_map' ? 'mindMapHint' : 'briefingHint'}`)}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-border p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <Database className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t('artifact.source')}</p>
                <p className="mt-1 text-sm text-text-secondary">
                  {selectedDocumentIds.length > 0
                    ? t('artifact.selectedDocuments', { count: selectedDocumentIds.length })
                    : t('artifact.wholeKnowledgeBase', {
                        count: knowledgeBaseDocumentCount,
                      })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={onAdjustSources}
                data-testid="artifact-create-adjust-sources"
              >
                <Settings2 className="mr-1.5 h-4 w-4" />
                {t('artifact.adjustSources')}
              </Button>
            </div>
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
            {isSubmitting ? t('artifact.creating') : t('artifact.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
