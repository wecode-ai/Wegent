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
import { KnowledgeBaseForm } from './KnowledgeBaseForm'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  KnowledgeBase,
  KnowledgeBaseUpdate,
  RetrievalConfigUpdate,
  SummaryModelRef,
} from '@/types/knowledge'
import type { RetrievalConfig } from './RetrievalSettingsSection'

interface EditKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase | null
  onSubmit: (data: KnowledgeBaseUpdate) => Promise<void>
  loading?: boolean
  /** Optional team ID for reading cached model preference (only used when KB has no existing summary_model_ref) */
  knowledgeDefaultTeamId?: number | null
}

export function EditKnowledgeBaseDialog({
  open,
  onOpenChange,
  knowledgeBase,
  onSubmit,
  loading,
  knowledgeDefaultTeamId,
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

  // Call limit configuration state
  const [maxCalls, setMaxCalls] = useState(10)
  const [exemptCalls, setExemptCalls] = useState(5)
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
      // Initialize call limits from knowledge base
      setMaxCalls(knowledgeBase.max_calls_per_conversation)
      setExemptCalls(knowledgeBase.exempt_calls_before_check)
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

    // Validate call limits
    if (exemptCalls >= maxCalls) {
      setError(t('knowledge:document.callLimits.validationError'))
      return
    }

    try {
      // Build update data
      const updateData: KnowledgeBaseUpdate = {
        name: name.trim(),
        description: description.trim(), // Allow empty string to clear description
        summary_enabled: summaryEnabled,
        summary_model_ref: summaryEnabled ? summaryModelRef : null,
        max_calls_per_conversation: maxCalls,
        exempt_calls_before_check: exemptCalls,
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
            <KnowledgeBaseForm
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
              knowledgeDefaultTeamId={
                !knowledgeBase?.summary_model_ref ? knowledgeDefaultTeamId : undefined
              }
              callLimits={{ maxCalls, exemptCalls }}
              onCallLimitsChange={({ maxCalls: nextMax, exemptCalls: nextExempt }) => {
                setMaxCalls(nextMax)
                setExemptCalls(nextExempt)
              }}
              advancedVariant="collapsible"
              advancedOpen={showAdvanced}
              onAdvancedOpenChange={setShowAdvanced}
              showRetrievalSection={!!knowledgeBase?.retrieval_config}
              retrievalConfig={retrievalConfig}
              onRetrievalConfigChange={handleRetrievalConfigChange}
              retrievalReadOnly={false}
              retrievalPartialReadOnly={true}
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
              {loading ? t('common:actions.saving') : t('common:actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
