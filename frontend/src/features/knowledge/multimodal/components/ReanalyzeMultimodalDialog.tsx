// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { isVideoFileName, isImageExtension } from '@/apis/attachments'
import { reindexDocument } from '@/apis/knowledge'
import { ApiError } from '@/apis/client'
import { toast } from '@/hooks/use-toast'
import type { KnowledgeDocument } from '@/types/knowledge'
import { MultimodalPromptEditor } from './MultimodalPromptEditor'

interface ReanalyzeMultimodalDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: KnowledgeDocument | null
  /** KB-level prompts (used to resolve the inherited effective value + source label) */
  kbVideoPrompt?: string | null
  kbImagePrompt?: string | null
  /** Refresh the document list after a successful re-dispatch */
  onReanalyzed?: () => void
}

export function ReanalyzeMultimodalDialog({
  open,
  onOpenChange,
  document: doc,
  kbVideoPrompt,
  kbImagePrompt,
  onReanalyzed,
}: ReanalyzeMultimodalDialogProps) {
  const { t } = useTranslation('knowledge')
  const [promptValue, setPromptValue] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Derive the document's media type from its name/extension. Normalize the
  // extension to a single leading dot (the stored value may or may not have one).
  const mediaType = useMemo<'video' | 'image' | null>(() => {
    if (!doc) return null
    if (isVideoFileName(doc.name)) return 'video'
    const ext = `.${(doc.file_extension || '').replace(/^\.+/, '')}`
    if (isImageExtension(ext)) return 'image'
    return null
  }, [doc])

  // The document's stored prompt override (document layer), if any.
  const docPrompt = useMemo<string | null>(() => {
    const cfg = (doc?.source_config ?? {}) as Record<string, unknown>
    const v = cfg.multimodal_analysis_prompt
    return typeof v === 'string' ? v : null
  }, [doc])

  // Reset working state whenever a new document is opened.
  useEffect(() => {
    if (open) {
      setPromptValue(docPrompt)
      setSubmitting(false)
    }
  }, [open, docPrompt])

  if (!doc || !mediaType) {
    return null
  }

  const kbPrompt = mediaType === 'video' ? kbVideoPrompt : kbImagePrompt

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      // Always send the current working text (even if unchanged from the
      // inherited value): a blank value clears the document override (revert
      // to KB default), a real string persists it. This keeps the document's
      // stored prompt explicit and visible.
      const result = await reindexDocument(doc.id, {
        multimodal_analysis_prompt: promptValue ?? '',
      })
      if (!result.success) {
        throw new Error(result.message || t('document.multimodal.reanalyzeFailed'))
      }
      toast({ description: t('document.multimodal.reanalyzeSuccess') })
      onOpenChange(false)
      onReanalyzed?.()
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : t('document.multimodal.reanalyzeFailed')
      toast({ description: message, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('document.multimodal.reanalyzeTitle')}</DialogTitle>
          <DialogDescription>
            {t('document.multimodal.reanalyzeDescription', {
              name: doc.name,
              type:
                mediaType === 'video'
                  ? t('document.multimodal.video')
                  : t('document.multimodal.image'),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto py-2">
          <MultimodalPromptEditor
            mediaType={mediaType}
            scope="document"
            value={promptValue}
            onChange={setPromptValue}
            kbPrompt={kbPrompt}
            idSuffix="reanalyze"
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="reanalyze-multimodal-cancel"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="reanalyze-multimodal-submit"
          >
            {submitting ? t('document.multimodal.reanalyzing') : t('document.multimodal.reanalyze')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
