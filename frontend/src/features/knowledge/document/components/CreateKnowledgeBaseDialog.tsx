// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { BookOpen, FolderOpen } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/hooks/useTranslation'
import type { SummaryModelRef, KnowledgeBaseType, RetrievalConfig } from '@/types/knowledge'
import { KnowledgeBaseForm } from './KnowledgeBaseForm'

interface CreateKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: {
    name: string
    description?: string
    retrieval_config?: Partial<RetrievalConfig>
    summary_enabled?: boolean
    summary_model_ref?: SummaryModelRef | null
    max_calls_per_conversation: number
    exempt_calls_before_check: number
  }) => Promise<void>
  loading?: boolean
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  /** Knowledge base type selected from dropdown menu (read-only in dialog) */
  kbType?: KnowledgeBaseType
  /** Optional team ID for reading cached model preference */
  knowledgeDefaultTeamId?: number | null
}

export function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
  scope,
  groupName,
  kbType = 'notebook',
  knowledgeDefaultTeamId,
}: CreateKnowledgeBaseDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // Default enable summary for notebook type, disable for classic type
  const [summaryEnabled, setSummaryEnabled] = useState(kbType === 'notebook')
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
  const [maxCalls, setMaxCalls] = useState(10)
  const [exemptCalls, setExemptCalls] = useState(5)

  // Reset summaryEnabled when dialog opens based on kbType
  // This is necessary because useState initial value only applies on first mount,
  // but the dialog component persists and kbType can change between opens
  useEffect(() => {
    if (open) {
      setSummaryEnabled(kbType === 'notebook')
    }
  }, [open, kbType])

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

    // Validate call limits
    if (exemptCalls >= maxCalls) {
      setError(t('knowledge:document.callLimits.validationError'))
      setAccordionValue('advanced')
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
        max_calls_per_conversation: maxCalls,
        exempt_calls_before_check: exemptCalls,
      })
      setName('')
      setDescription('')
      // Reset summaryEnabled based on kbType: enabled for notebook, disabled for classic
      setSummaryEnabled(kbType === 'notebook')
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
      setMaxCalls(10)
      setExemptCalls(5)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:error'))
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setName('')
      setDescription('')
      // Reset summaryEnabled based on kbType: enabled for notebook, disabled for classic
      setSummaryEnabled(kbType === 'notebook')
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
      setMaxCalls(10)
      setExemptCalls(5)
      setError('')
      setAccordionValue('')
    }
    onOpenChange(newOpen)
  }

  // Determine if this is a notebook type
  const isNotebook = kbType === 'notebook'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('knowledge:document.knowledgeBase.create')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="max-h-[80vh] overflow-y-auto">
          <div className="space-y-4 py-4">
            <KnowledgeBaseForm
              typeSection={
                <div className="space-y-2">
                  <Label>{t('knowledge:document.knowledgeBase.type')}</Label>
                  <div
                    className={`flex items-center gap-3 p-3 rounded-md border ${
                      isNotebook ? 'bg-primary/5 border-primary/20' : 'bg-muted border-border'
                    }`}
                  >
                    <div
                      className={`flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center ${
                        isNotebook ? 'bg-primary/10 text-primary' : 'bg-surface text-text-secondary'
                      }`}
                    >
                      {isNotebook ? (
                        <BookOpen className="w-4 h-4" />
                      ) : (
                        <FolderOpen className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <div className="font-medium text-sm">
                        {isNotebook
                          ? t('knowledge:document.knowledgeBase.typeNotebook')
                          : t('knowledge:document.knowledgeBase.typeClassic')}
                      </div>
                      <div className="text-xs text-text-muted">
                        {isNotebook
                          ? t('knowledge:document.knowledgeBase.notebookDesc')
                          : t('knowledge:document.knowledgeBase.classicDesc')}
                      </div>
                    </div>
                  </div>
                </div>
              }
              name={name}
              description={description}
              onNameChange={value => setName(value)}
              onDescriptionChange={value => setDescription(value)}
              summaryEnabled={summaryEnabled}
              onSummaryEnabledChange={checked => {
                setSummaryEnabled(checked)
                if (!checked) {
                  setSummaryModelRef(null)
                  setSummaryModelError('')
                }
              }}
              summaryModelRef={summaryModelRef}
              summaryModelError={summaryModelError}
              onSummaryModelChange={value => {
                setSummaryModelRef(value)
                setSummaryModelError('')
              }}
              knowledgeDefaultTeamId={knowledgeDefaultTeamId}
              callLimits={{ maxCalls, exemptCalls }}
              onCallLimitsChange={({ maxCalls: nextMax, exemptCalls: nextExempt }) => {
                setMaxCalls(nextMax)
                setExemptCalls(nextExempt)
              }}
              advancedVariant="accordion"
              advancedOpen={accordionValue === 'advanced'}
              onAdvancedOpenChange={open => setAccordionValue(open ? 'advanced' : '')}
              advancedDescription={t('knowledge:document.advancedSettings.collapsed')}
              showRetrievalSection={true}
              retrievalConfig={retrievalConfig}
              onRetrievalConfigChange={setRetrievalConfig}
              retrievalScope={scope}
              retrievalGroupName={groupName}
            />

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
