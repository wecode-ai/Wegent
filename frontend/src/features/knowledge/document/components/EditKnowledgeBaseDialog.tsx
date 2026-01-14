// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  KnowledgeBase,
  KnowledgeBaseUpdate,
  RetrievalConfigUpdate,
  SummaryModelRef,
} from '@/types/knowledge'
import { RetrievalSettingsSection, RetrievalConfig } from './RetrievalSettingsSection'
import { SummaryModelSelector } from './SummaryModelSelector'

interface EditKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase | null
  onSubmit: (data: KnowledgeBaseUpdate) => Promise<void>
  loading?: boolean
}

export function EditKnowledgeBaseDialog({
  open,
  onOpenChange,
  knowledgeBase,
  onSubmit,
  loading,
}: EditKnowledgeBaseDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [summaryEnabled, setSummaryEnabled] = useState(false)
  const [summaryModelRef, setSummaryModelRef] = useState<SummaryModelRef | null>(null)
  const [summaryModelError, setSummaryModelError] = useState('')
  const [error, setError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [retrievalConfig, setRetrievalConfig] = useState<Partial<RetrievalConfig>>({})

  useEffect(() => {
    if (knowledgeBase) {
      setName(knowledgeBase.name)
      setDescription(knowledgeBase.description || '')
      setSummaryEnabled(knowledgeBase.summary_enabled || false)
      setSummaryModelRef(knowledgeBase.summary_model_ref || null)
      setSummaryModelError('')
      setShowAdvanced(false) // Reset expanded state
      // Initialize retrieval config from knowledge base
      if (knowledgeBase.retrieval_config) {
        setRetrievalConfig(knowledgeBase.retrieval_config)
      }
    }
  }, [knowledgeBase])

  const handleRetrievalConfigChange = useCallback((config: Partial<RetrievalConfig>) => {
    setRetrievalConfig(config)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSummaryModelError('')

    if (!name.trim()) {
      setError(t('knowledge:document.knowledgeBase.nameRequired'))
      return
    }

    if (name.length > 100) {
      setError(t('knowledge:document.knowledgeBase.nameTooLong'))
      return
    }

    // Validate summary model when summary is enabled
    if (summaryEnabled && !summaryModelRef) {
      setSummaryModelError(t('knowledge:document.summary.modelRequired'))
      return
    }

    try {
      // Build update data
      const updateData: KnowledgeBaseUpdate = {
        name: name.trim(),
        description: description.trim(), // Allow empty string to clear description
        summary_enabled: summaryEnabled,
        summary_model_ref: summaryEnabled ? summaryModelRef : null,
      }

      // Add retrieval config update if advanced settings were modified
      if (knowledgeBase?.retrieval_config && retrievalConfig) {
        const retrievalConfigUpdate: RetrievalConfigUpdate = {}

        // Only include fields that can be updated (exclude retriever and embedding_config)
        if (retrievalConfig.retrieval_mode !== undefined) {
          retrievalConfigUpdate.retrieval_mode = retrievalConfig.retrieval_mode
        }
        if (retrievalConfig.top_k !== undefined) {
          retrievalConfigUpdate.top_k = retrievalConfig.top_k
        }
        if (retrievalConfig.score_threshold !== undefined) {
          retrievalConfigUpdate.score_threshold = retrievalConfig.score_threshold
        }
        if (retrievalConfig.hybrid_weights !== undefined) {
          retrievalConfigUpdate.hybrid_weights = retrievalConfig.hybrid_weights
        }

        // Only add retrieval_config if there are changes
        if (Object.keys(retrievalConfigUpdate).length > 0) {
          updateData.retrieval_config = retrievalConfigUpdate
        }
      }

      await onSubmit(updateData)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error'))
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setError('')
      setSummaryModelError('')
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.knowledgeBase.edit')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('knowledge:document.knowledgeBase.name')}</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('knowledge:document.knowledgeBase.namePlaceholder')}
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">
                {t('knowledge:document.knowledgeBase.description')}
              </Label>
              <Textarea
                id="edit-description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={t('knowledge:document.knowledgeBase.descriptionPlaceholder')}
                maxLength={500}
                rows={3}
              />
            </div>

            {/* Summary Settings - moved outside advanced settings */}
            <div className="space-y-3 border-b border-border pb-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="edit-summary-enabled">
                    {t('knowledge:document.summary.enableLabel')}
                  </Label>
                  <p className="text-xs text-text-muted">
                    {t('knowledge:document.summary.enableDescription')}
                  </p>
                </div>
                <Switch
                  id="edit-summary-enabled"
                  checked={summaryEnabled}
                  onCheckedChange={checked => {
                    setSummaryEnabled(checked)
                    if (!checked) {
                      setSummaryModelRef(null)
                      setSummaryModelError('')
                    }
                  }}
                />
              </div>
              {summaryEnabled && (
                <div className="space-y-2 pt-2">
                  <Label>{t('knowledge:document.summary.selectModel')}</Label>
                  <SummaryModelSelector
                    value={summaryModelRef}
                    onChange={value => {
                      setSummaryModelRef(value)
                      setSummaryModelError('')
                    }}
                    error={summaryModelError}
                  />
                </div>
              )}
            </div>

            {/* Advanced Settings (Partially Editable) */}
            {knowledgeBase?.retrieval_config && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-primary transition-colors"
                >
                  {showAdvanced ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  {t('knowledge:document.advancedSettings.title')}
                </button>

                {showAdvanced && (
                  <div className="mt-4 p-4 bg-bg-muted rounded-lg border border-border space-y-4">
                    <RetrievalSettingsSection
                      config={retrievalConfig}
                      onChange={handleRetrievalConfigChange}
                      readOnly={false}
                      partialReadOnly={true}
                    />
                  </div>
                )}
              </div>
            )}

            {error && <p className="text-sm text-error">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={loading}>
              {loading ? t('common:actions.saving') : t('common:actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
