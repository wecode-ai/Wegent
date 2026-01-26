// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { BookOpen, FolderOpen } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { updateKnowledgeBaseType } from '@/apis/knowledge'
import { toast } from '@/hooks/use-toast'
import type { KnowledgeBase, KnowledgeBaseType } from '@/types/knowledge'

interface ConvertKnowledgeBaseTypeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase | null
  onSuccess?: (updatedKb: KnowledgeBase) => void
}

export function ConvertKnowledgeBaseTypeDialog({
  open,
  onOpenChange,
  knowledgeBase,
  onSuccess,
}: ConvertKnowledgeBaseTypeDialogProps) {
  const { t } = useTranslation('knowledge')
  const [loading, setLoading] = useState(false)

  if (!knowledgeBase) return null

  // Determine current and target types
  const currentType = knowledgeBase.kb_type || 'notebook'
  const targetType: KnowledgeBaseType = currentType === 'notebook' ? 'classic' : 'notebook'
  const isConvertingToNotebook = targetType === 'notebook'

  // Get confirmation message based on conversion direction
  const confirmMessage = isConvertingToNotebook
    ? t('document.knowledgeBase.convertToNotebookConfirm')
    : t('document.knowledgeBase.convertToClassicConfirm')

  const handleConfirm = async () => {
    setLoading(true)
    try {
      const updatedKb = await updateKnowledgeBaseType(knowledgeBase.id, targetType)
      toast({
        description: t('document.knowledgeBase.convertSuccess'),
      })
      onOpenChange(false)
      // Call onSuccess to notify parent components to refresh
      // The parent page.tsx will re-fetch knowledge base data and re-route
      // to the appropriate layout component based on the new kb_type
      onSuccess?.(updatedKb)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : t('document.knowledgeBase.convertFailed')
      toast({
        variant: 'destructive',
        description: errorMessage,
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('document.knowledgeBase.convertType')}</DialogTitle>
          <DialogDescription>{confirmMessage}</DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <div className="flex items-center gap-3">
            {/* Current type */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface border border-border">
              {currentType === 'notebook' ? (
                <BookOpen className="w-4 h-4 text-primary" />
              ) : (
                <FolderOpen className="w-4 h-4 text-text-secondary" />
              )}
              <span className="text-sm font-medium">
                {currentType === 'notebook'
                  ? t('document.knowledgeBase.typeNotebook')
                  : t('document.knowledgeBase.typeClassic')}
              </span>
            </div>
            {/* Arrow */}
            <span className="text-text-muted">→</span>
            {/* Target type */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/20">
              {targetType === 'notebook' ? (
                <BookOpen className="w-4 h-4 text-primary" />
              ) : (
                <FolderOpen className="w-4 h-4 text-text-secondary" />
              )}
              <span className="text-sm font-medium text-primary">
                {targetType === 'notebook'
                  ? t('document.knowledgeBase.typeNotebook')
                  : t('document.knowledgeBase.typeClassic')}
              </span>
            </div>
          </div>
          <p className="text-sm text-text-muted mt-3">{knowledgeBase.name}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" onClick={handleConfirm} disabled={loading}>
            {loading ? t('common:actions.processing') : t('common:actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
