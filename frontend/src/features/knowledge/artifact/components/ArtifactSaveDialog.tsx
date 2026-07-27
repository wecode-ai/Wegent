// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { createTextKnowledgeDocument } from '@/apis/knowledge'
import { WysiwygEditor } from '@/components/common/WysiwygEditor'
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
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'

interface ArtifactSaveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBaseId: number
  initialTitle: string
  initialContent: string
  onSaved: () => void
}

export function ArtifactSaveDialog({
  open,
  onOpenChange,
  knowledgeBaseId,
  initialTitle,
  initialContent,
  onSaved,
}: ArtifactSaveDialogProps) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()
  const [title, setTitle] = useState(initialTitle)
  const [content, setContent] = useState(initialContent)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setTitle(initialTitle)
      setContent(initialContent)
    }
  }, [open, initialTitle, initialContent])

  const handleSave = async () => {
    const normalizedTitle = title.trim()
    const normalizedContent = content.trim()
    if (!normalizedTitle || !normalizedContent) return

    setIsSaving(true)
    try {
      await createTextKnowledgeDocument({
        knowledge_base_id: knowledgeBaseId,
        name: normalizedTitle,
        content: normalizedContent,
      })
      onSaved()
      onOpenChange(false)
    } catch (error) {
      toast({
        description: error instanceof Error ? error.message : t('artifact.operationFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] max-w-5xl flex-col"
        data-testid="artifact-save-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('artifact.saveToKnowledge')}</DialogTitle>
          <DialogDescription>{t('artifact.saveToKnowledgeHint')}</DialogDescription>
        </DialogHeader>
        <Input
          value={title}
          onChange={event => setTitle(event.target.value)}
          maxLength={255}
          data-testid="artifact-save-title-input"
        />
        <WysiwygEditor
          initialContent={initialContent}
          onChange={setContent}
          className="min-h-0 flex-1"
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="artifact-save-cancel"
          >
            {t('artifact.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={isSaving || !title.trim() || !content.trim()}
            data-testid="artifact-save-submit"
          >
            {isSaving ? t('artifact.saving') : t('artifact.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
