// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { ArrowRightLeft, BookOpen, Database } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { KnowledgeBaseForm } from './KnowledgeBaseForm'
import { ConvertKnowledgeBaseTypeDialog } from './ConvertKnowledgeBaseTypeDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { getKnowledgeBase } from '@/apis/knowledge'
import type {
  KnowledgeBase,
  KnowledgeBaseUpdate,
  RetrievalConfigUpdate,
  SummaryModelRef,
} from '@/types/knowledge'
import type { RetrievalConfig } from './RetrievalSettingsSection'

// Maximum documents allowed for notebook type
const NOTEBOOK_MAX_DOCUMENTS = 50

interface EditKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase | null
  onSubmit: (data: KnowledgeBaseUpdate) => Promise<void>
  loading?: boolean
  /** Optional team ID for reading cached model preference (only used when KB has no existing summary_model_ref) */
  knowledgeDefaultTeamId?: number | null
  /** Callback when knowledge base type is converted */
  onTypeConverted?: (updatedKb: KnowledgeBase) => void
}

export function EditKnowledgeBaseDialog({
  open,
  onOpenChange,
  knowledgeBase,
  onSubmit,
  loading,
  knowledgeDefaultTeamId,
  onTypeConverted,
}: EditKnowledgeBaseDialogProps) {
  const { t } = useTranslation()
  const { t: tKnowledge } = useTranslation('knowledge')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [summaryEnabled, setSummaryEnabled] = useState(false)
  const [summaryModelRef, setSummaryModelRef] = useState<SummaryModelRef | null>(null)
  const [summaryModelError, setSummaryModelError] = useState('')
  const [error, setError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [retrievalConfig, setRetrievalConfig] = useState<Partial<RetrievalConfig>>({})
  const [guidedQuestions, setGuidedQuestions] = useState<string[]>([])

  // Call limit configuration state
  const [maxCalls, setMaxCalls] = useState(10)
  const [exemptCalls, setExemptCalls] = useState(5)

  // Convert type dialog state
  const [showConvertDialog, setShowConvertDialog] = useState(false)

  // Full knowledge base data (fetched from API)
  const [fullKnowledgeBase, setFullKnowledgeBase] = useState<KnowledgeBase | null>(null)

  // Fetch full knowledge base data when dialog opens
  useEffect(() => {
    if (open && knowledgeBase?.id) {
      getKnowledgeBase(knowledgeBase.id)
        .then(fullKb => {
          setFullKnowledgeBase(fullKb)
        })
        .catch(err => {
          console.error('Failed to fetch full knowledge base data:', err)
          // Fallback to the partial data
          setFullKnowledgeBase(knowledgeBase)
        })
    } else if (!open) {
      setFullKnowledgeBase(null)
    }
  }, [open, knowledgeBase?.id])

  // Initialize form fields when full data is loaded
  useEffect(() => {
    const kb = fullKnowledgeBase || knowledgeBase
    if (kb) {
      setName(kb.name)
      setDescription(kb.description || '')
      setSummaryEnabled(kb.summary_enabled || false)
      setSummaryModelRef(kb.summary_model_ref || null)
      setSummaryModelError('')
      setShowAdvanced(false) // Reset expanded state
      // Initialize retrieval config from knowledge base
      if (kb.retrieval_config) {
        setRetrievalConfig(kb.retrieval_config)
      }
      // Initialize call limits from knowledge base
      setMaxCalls(kb.max_calls_per_conversation)
      setExemptCalls(kb.exempt_calls_before_check)
      // Initialize guided questions from knowledge base
      setGuidedQuestions(kb.guided_questions || [])
    }
  }, [fullKnowledgeBase, knowledgeBase])

  const handleRetrievalConfigChange = useCallback((config: Partial<RetrievalConfig>) => {
    setRetrievalConfig(config)
  }, [])

  const handleSubmit = async () => {
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
      // Filter out empty guided questions
      const validGuidedQuestions = guidedQuestions.filter(q => q.trim().length > 0)
      // Use fullKnowledgeBase for accurate data, fallback to initial prop
      const kb = fullKnowledgeBase || knowledgeBase
      const isNotebook = kb?.kb_type === 'notebook'
      const updateData: KnowledgeBaseUpdate = {
        name: name.trim(),
        description: description.trim(), // Allow empty string to clear description
        summary_enabled: summaryEnabled,
        summary_model_ref: summaryEnabled ? summaryModelRef : null,
        guided_questions: isNotebook ? validGuidedQuestions : undefined,
        max_calls_per_conversation: maxCalls,
        exempt_calls_before_check: exemptCalls,
      }

      // Add retrieval config update if advanced settings were modified
      if (kb?.retrieval_config && retrievalConfig) {
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

  // Knowledge base type info - use fullKnowledgeBase for accurate data
  const kb = fullKnowledgeBase || knowledgeBase
  const kbType = kb?.kb_type || 'notebook'
  const isNotebook = kbType === 'notebook'
  // Check if can convert to notebook (document count must be <= 50)
  const canConvertToNotebook =
    (fullKnowledgeBase?.document_count || knowledgeBase?.document_count || 0) <=
    NOTEBOOK_MAX_DOCUMENTS

  // Handle type conversion success
  const handleTypeConverted = (updatedKb: KnowledgeBase) => {
    setShowConvertDialog(false)
    onOpenChange(false)
    onTypeConverted?.(updatedKb)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('knowledge:document.knowledgeBase.edit')}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 py-4">
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
              knowledgeDefaultTeamId={!kb?.summary_model_ref ? knowledgeDefaultTeamId : undefined}
              callLimits={{ maxCalls, exemptCalls }}
              onCallLimitsChange={({ maxCalls: nextMax, exemptCalls: nextExempt }) => {
                setMaxCalls(nextMax)
                setExemptCalls(nextExempt)
              }}
              advancedVariant="collapsible"
              advancedOpen={showAdvanced}
              onAdvancedOpenChange={setShowAdvanced}
              showRetrievalSection={!!kb?.retrieval_config}
              retrievalConfig={retrievalConfig}
              onRetrievalConfigChange={handleRetrievalConfigChange}
              retrievalReadOnly={false}
              retrievalPartialReadOnly={true}
              showGuidedQuestions={kb?.kb_type === 'notebook'}
              guidedQuestions={guidedQuestions}
              onGuidedQuestionsChange={setGuidedQuestions}
            />

            {/* Convert type section */}
            <div className="border-t border-border pt-4 mt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isNotebook ? (
                    <BookOpen className="w-4 h-4 text-primary" />
                  ) : (
                    <Database className="w-4 h-4 text-text-secondary" />
                  )}
                  <span className="text-sm font-medium">
                    {tKnowledge('document.knowledgeBase.currentType')}:{' '}
                    {isNotebook
                      ? tKnowledge('document.knowledgeBase.typeNotebook')
                      : tKnowledge('document.knowledgeBase.typeClassic')}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowConvertDialog(true)}
                  disabled={!isNotebook && !canConvertToNotebook}
                  className="flex items-center gap-1.5"
                >
                  <ArrowRightLeft className="w-4 h-4" />
                  {isNotebook
                    ? tKnowledge('document.knowledgeBase.convertToClassic')
                    : tKnowledge('document.knowledgeBase.convertToNotebook')}
                </Button>
              </div>
              {/* Show hint when convert to notebook is disabled */}
              {!isNotebook && !canConvertToNotebook && (
                <p className="text-xs text-text-muted mt-2">
                  {tKnowledge('document.knowledgeBase.convertToNotebookDisabled')}
                </p>
              )}
            </div>

            {error && <p className="text-sm text-error">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
              className="h-11 min-w-[44px]"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              variant="primary"
              disabled={loading}
              className="h-11 min-w-[44px]"
            >
              {loading ? t('common:actions.saving') : t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Convert type dialog */}
      <ConvertKnowledgeBaseTypeDialog
        open={showConvertDialog}
        onOpenChange={setShowConvertDialog}
        knowledgeBase={fullKnowledgeBase || knowledgeBase}
        onSuccess={handleTypeConverted}
      />
    </>
  )
}
