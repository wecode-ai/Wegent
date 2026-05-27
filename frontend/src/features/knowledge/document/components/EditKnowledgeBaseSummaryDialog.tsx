// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { KnowledgeBase } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

interface EditKnowledgeBaseSummaryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase
  onSave: (longSummary: string) => Promise<void>
  onReset: () => Promise<void>
}

export function EditKnowledgeBaseSummaryDialog({
  open,
  onOpenChange,
  knowledgeBase,
  onSave,
  onReset,
}: EditKnowledgeBaseSummaryDialogProps) {
  const { t } = useTranslation('knowledge')
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    if (!open) return
    setValue(knowledgeBase.summary?.manual_long_summary || '')
    setError('')
  }, [open, knowledgeBase.summary?.manual_long_summary])

  const handleSave = async () => {
    const normalized = value.trim()
    if (!normalized) {
      setError(t('chatPage.summaryEditRequired'))
      return
    }

    if (normalized.length > 500) {
      setError(t('chatPage.summaryEditTooLong'))
      return
    }

    setSaving(true)
    setError('')
    try {
      await onSave(normalized)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error'))
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setResetting(true)
    setError('')
    try {
      await onReset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error'))
    } finally {
      setResetting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('chatPage.summaryEditTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-text-muted">{t('chatPage.summaryEditDescription')}</p>
          <Textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            rows={8}
            maxLength={500}
            placeholder={
              knowledgeBase.summary?.long_summary || t('chatPage.summaryEditPlaceholder')
            }
            data-testid="kb-summary-edit-input"
          />
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>
              {knowledgeBase.summary?.manual_long_summary ? t('chatPage.summaryManualHint') : ''}
            </span>
            <span>{value.length}/500</span>
          </div>
          {error ? <p className="text-xs text-error">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving || resetting}
            data-testid="kb-summary-cancel-button"
            className="h-11 min-w-[44px]"
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleReset}
            disabled={saving || resetting || !knowledgeBase.summary?.manual_long_summary}
            data-testid="kb-summary-reset-button"
            className="h-11 min-w-[44px]"
          >
            {resetting ? t('chatPage.summaryResetting') : t('chatPage.summaryReset')}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleSave}
            disabled={saving || resetting || !value.trim()}
            data-testid="kb-summary-save-button"
            className="h-11 min-w-[44px]"
          >
            {saving ? t('common:actions.saving') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
