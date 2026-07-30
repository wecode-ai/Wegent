// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

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
import { Label } from '@/components/ui/label'
import {
  MAX_KNOWLEDGE_DOCUMENT_TITLE_LENGTH,
  useSaveKnowledgeDocument,
} from '@/features/knowledge/document/hooks/useSaveKnowledgeDocument'
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
  const { title, setTitle, setContent, isSaving, isValid, submit } = useSaveKnowledgeDocument({
    open,
    initialTitle,
    initialContent,
    knowledgeBaseId,
    onSaved: () => {
      onSaved()
      onOpenChange(false)
    },
    onError: error => {
      toast({
        description: t(`artifact.saveErrors.${error}`),
        variant: 'destructive',
      })
    },
  })

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
        <div className="space-y-1.5">
          <Label htmlFor="artifact-save-title">{t('artifact.titleLabel')}</Label>
          <Input
            id="artifact-save-title"
            value={title}
            onChange={event => setTitle(event.target.value)}
            maxLength={MAX_KNOWLEDGE_DOCUMENT_TITLE_LENGTH}
            data-testid="artifact-save-title-input"
          />
        </div>
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
            onClick={() => void submit()}
            disabled={isSaving || !isValid}
            data-testid="artifact-save-submit"
          >
            {isSaving ? t('artifact.saving') : t('artifact.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
