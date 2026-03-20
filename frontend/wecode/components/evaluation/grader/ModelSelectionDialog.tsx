// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Loader2, Info } from 'lucide-react'
import { EvaluationModelSelector } from '@wecode/components/evaluation/common/EvaluationModelSelector'
import { getAuthorGradingConfig } from '@wecode/api/evaluation-author'
import { useTranslation } from '@/hooks/useTranslation'

interface ModelSelectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  topicId: number | null
  onConfirm: (modelId: string | undefined, forceOverride: boolean) => void | Promise<void>
  title?: string
  description?: string
  confirmText?: string
  cancelText?: string
  loading?: boolean
}

/**
 * Reusable model selection dialog component for grading tasks.
 * Automatically selects model from topic config when opened.
 * Uses EvaluationModelSelector for consistent UI.
 */
export function ModelSelectionDialog({
  open,
  onOpenChange,
  topicId,
  onConfirm,
  title,
  description,
  confirmText,
  cancelText,
  loading = false,
}: ModelSelectionDialogProps) {
  const { t } = useTranslation('evaluation')
  const [defaultModelName, setDefaultModelName] = useState<string | null>(null)

  // Local state for model selection
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [forceOverride, setForceOverride] = useState(false)

  // Reset and auto-select model when dialog opens
  useEffect(() => {
    if (!open) return

    // Reset state
    setSelectedModel('')
    setForceOverride(false)
    setDefaultModelName(null)

    if (!topicId) return

    // Auto-select model from topic config
    const autoSelectModel = async () => {
      try {
        const config = await getAuthorGradingConfig(topicId)

        if (config.model_id) {
          setDefaultModelName(config.model_id)
          setSelectedModel(config.model_id)
          setForceOverride(config.force_override_bot_model || false)
        } else {
          setForceOverride(config.force_override_bot_model || false)
        }
      } catch (_error) {
        // Silently fail - user can manually select model
      }
    }

    autoSelectModel()
  }, [open, topicId])

  const handleConfirm = () => {
    onConfirm(selectedModel || undefined, forceOverride)
  }

  const handleCancel = () => {
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{title || t('grading.model_config')}</DialogTitle>
          <DialogDescription>
            {description || t('grading.select_model_description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Show default model info */}
          {defaultModelName && (
            <div className="rounded-lg bg-surface border border-border p-3">
              <div className="flex items-start gap-2">
                <Info className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                <div className="text-sm">
                  <span className="text-text-secondary">
                    {t('grading.default_model') || '默认配置模型'}:{' '}
                  </span>
                  <span className="font-medium text-text-primary">{defaultModelName}</span>
                  <p className="mt-1 text-text-muted text-xs">
                    {t('grading.use_default_model_hint') ||
                      '可直接确认使用默认模型，或选择其他模型覆盖'}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label>{t('grading.model')}</Label>
            <EvaluationModelSelector
              value={selectedModel}
              onChange={(modelId, force) => {
                setSelectedModel(modelId)
                setForceOverride(force)
              }}
              forceOverride={forceOverride}
              disabled={loading}
              placeholder={t('grading.select_model') || 'Select Model'}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={loading}>
            {cancelText || t('common:actions.cancel', 'Cancel')}
          </Button>
          <Button variant="primary" onClick={handleConfirm} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('grading.executing', 'Executing...')}
              </>
            ) : (
              confirmText || t('common:actions.confirm', 'Confirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
