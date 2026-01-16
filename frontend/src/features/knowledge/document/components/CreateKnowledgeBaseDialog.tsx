// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { useTranslation } from '@/hooks/useTranslation'
import { RetrievalSettingsSection, type RetrievalConfig } from './RetrievalSettingsSection'
import { SummaryModelSelector } from './SummaryModelSelector'
import type { SummaryModelRef } from '@/types/knowledge'

interface CreateKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: {
    name: string
    description?: string
    retrieval_config?: Partial<RetrievalConfig>
    summary_enabled?: boolean
    summary_model_ref?: SummaryModelRef | null
  }) => Promise<void>
  loading?: boolean
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
}

export function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
  scope,
  groupName,
}: CreateKnowledgeBaseDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [summaryEnabled, setSummaryEnabled] = useState(false)
  const [summaryModelRef, setSummaryModelRef] = useState<SummaryModelRef | null>(null)
  const [summaryModelError, setSummaryModelError] = useState('')
  const [retrievalConfig, setRetrievalConfig] = useState<Partial<RetrievalConfig>>({
    retrieval_mode: 'vector',
    top_k: 5,
    score_threshold: 0.5,
    hybrid_weights: {
      vector_weight: 0.7,
      keyword_weight: 0.3,
    },
  })
  const [error, setError] = useState('')
  const [accordionValue, setAccordionValue] = useState<string>('')

  // Note: Auto-selection of retriever and embedding model is handled by RetrievalSettingsSection

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

    // Validate retrieval config - retriever and embedding model are required
    if (!retrievalConfig.retriever_name) {
      setError(t('knowledge:document.retrieval.noRetriever'))
      setAccordionValue('advanced')
      return
    }

    if (!retrievalConfig.embedding_config?.model_name) {
      setError(t('knowledge:document.retrieval.noEmbeddingModel'))
      setAccordionValue('advanced')
      return
    }

    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        retrieval_config: retrievalConfig,
        summary_enabled: summaryEnabled,
        summary_model_ref: summaryEnabled ? summaryModelRef : null,
      })
      setName('')
      setDescription('')
      setSummaryEnabled(false)
      setSummaryModelRef(null)
      setRetrievalConfig({
        retrieval_mode: 'vector',
        top_k: 5,
        score_threshold: 0.5,
        hybrid_weights: {
          vector_weight: 0.7,
          keyword_weight: 0.3,
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error'))
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setName('')
      setDescription('')
      setSummaryEnabled(false)
      setSummaryModelRef(null)
      setSummaryModelError('')
      setRetrievalConfig({
        retrieval_mode: 'vector',
        top_k: 5,
        score_threshold: 0.5,
        hybrid_weights: {
          vector_weight: 0.7,
          keyword_weight: 0.3,
        },
      })
      setError('')
      setAccordionValue('')
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.knowledgeBase.create')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="max-h-[80vh] overflow-y-auto">
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('knowledge:document.knowledgeBase.name')}</Label>
              <Input
                id="name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('knowledge:document.knowledgeBase.namePlaceholder')}
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">
                {t('knowledge:document.knowledgeBase.description')}
              </Label>
              <Textarea
                id="description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={t('knowledge:document.knowledgeBase.descriptionPlaceholder')}
                maxLength={500}
                rows={3}
              />
            </div>

            {/* Summary Settings - moved outside accordion */}
            <div className="space-y-3 border-b border-border pb-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="summary-enabled">
                    {t('knowledge:document.summary.enableLabel')}
                  </Label>
                  <p className="text-xs text-text-muted">
                    {t('knowledge:document.summary.enableDescription')}
                  </p>
                </div>
                <Switch
                  id="summary-enabled"
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

            {/* Advanced Settings */}
            <Accordion
              type="single"
              collapsible
              className="border-none"
              value={accordionValue}
              onValueChange={setAccordionValue}
            >
              <AccordionItem value="advanced" className="border-none">
                <AccordionTrigger className="text-sm font-medium hover:no-underline">
                  {t('knowledge:document.advancedSettings.title')}
                </AccordionTrigger>
                <AccordionContent
                  forceMount
                  className={accordionValue !== 'advanced' ? 'hidden' : ''}
                >
                  <div className="space-y-4 pt-2">
                    <p className="text-xs text-text-muted">
                      {t('knowledge:document.advancedSettings.collapsed')}
                    </p>

                    <RetrievalSettingsSection
                      config={retrievalConfig}
                      onChange={setRetrievalConfig}
                      scope={scope}
                      groupName={groupName}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

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
              {loading ? t('common:actions.creating') : t('common:actions.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
