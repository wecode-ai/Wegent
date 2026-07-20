// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { BookOpen, Database } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { KnowledgeBaseForm } from './KnowledgeBaseForm'
import { useMultimodalKBConfig } from '@/features/knowledge/multimodal/hooks/useMultimodalKBConfig'
import { useMultimodalFeatureEnabled } from '@/features/knowledge/multimodal/hooks/useMultimodalFeatureEnabled'
import { ConvertKnowledgeBaseTypeDialog } from './ConvertKnowledgeBaseTypeDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { getKnowledgeBase } from '@/apis/knowledge'
import type {
  DirectAccessRequirement,
  KnowledgeBase,
  KnowledgeBaseUpdate,
  RetrievalConfigDraft,
  RetrievalConfigUpdate,
  SummaryModelRef,
} from '@/types/knowledge'

interface EditKnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase | null
  onSubmit: (data: KnowledgeBaseUpdate) => Promise<void>
  loading?: boolean
  /** Optional team ID for reading cached model preference (only used when KB has no existing summary_model_ref) */
  knowledgeDefaultTeamId?: number | null
  /** Optional bind model name from team's bot config as fallback */
  bindModel?: string | null
  /** Callback when default opening view is updated */
  onTypeConverted?: (updatedKb: KnowledgeBase) => void
}

export function EditKnowledgeBaseDialog({
  open,
  onOpenChange,
  knowledgeBase,
  onSubmit,
  loading,
  knowledgeDefaultTeamId,
  bindModel,
  onTypeConverted,
}: EditKnowledgeBaseDialogProps) {
  const { t } = useTranslation()
  const { t: tKnowledge } = useTranslation('knowledge')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [directAccessRequirement, setDirectAccessRequirement] =
    useState<DirectAccessRequirement>('read')
  const [summaryEnabled, setSummaryEnabled] = useState(false)
  const [summaryModelRef, setSummaryModelRef] = useState<SummaryModelRef | null>(null)
  const [summaryModelError, setSummaryModelError] = useState('')
  const {
    multimodalAnalysisEnabled,
    multimodalVideoPrompt,
    multimodalImagePrompt,
    loadFromKB: loadMultimodalFromKB,
    validate: validateMultimodal,
    clearError: clearMultimodalError,
    buildSubmitFields: buildMultimodalSubmitFields,
    formProps: multimodalFormProps,
  } = useMultimodalKBConfig()
  // Gate prompt overrides by the global pipeline switch, the same way
  // buildMultimodalSubmitFields() gates multimodal_analysis_enabled. Otherwise
  // saving a previously-enabled KB after the switch is turned off would send
  // enabled=false alongside the (non-blank) prompt text.
  const multimodalFeatureEnabled = useMultimodalFeatureEnabled()
  const effectiveMultimodalEnabled = multimodalFeatureEnabled && multimodalAnalysisEnabled
  const [error, setError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [retrievalConfig, setRetrievalConfig] = useState<RetrievalConfigDraft>({})
  const [guidedQuestions, setGuidedQuestions] = useState<string[]>([])

  // Call limit configuration state
  const [maxCalls, setMaxCalls] = useState(10)
  const [exemptCalls, setExemptCalls] = useState(5)

  // Default view dialog state
  const [showConvertDialog, setShowConvertDialog] = useState(false)

  // Full knowledge base data (fetched from API)
  const [fullKnowledgeBase, setFullKnowledgeBase] = useState<KnowledgeBase | null>(null)
  const [isLoadingFullKnowledgeBase, setIsLoadingFullKnowledgeBase] = useState(false)
  const [fullKnowledgeBaseLoadFailed, setFullKnowledgeBaseLoadFailed] = useState(false)
  const fullKnowledgeBaseRequestId = useRef(0)

  const loadFullKnowledgeBase = useCallback(async (knowledgeBaseId: number) => {
    const requestId = ++fullKnowledgeBaseRequestId.current
    setFullKnowledgeBase(null)
    setIsLoadingFullKnowledgeBase(true)
    setFullKnowledgeBaseLoadFailed(false)

    try {
      const fullKb = await getKnowledgeBase(knowledgeBaseId)
      if (fullKnowledgeBaseRequestId.current === requestId) {
        setFullKnowledgeBase(fullKb)
      }
    } catch (err) {
      console.error('Failed to fetch full knowledge base data:', err)
      if (fullKnowledgeBaseRequestId.current === requestId) {
        setFullKnowledgeBaseLoadFailed(true)
      }
    } finally {
      if (fullKnowledgeBaseRequestId.current === requestId) {
        setIsLoadingFullKnowledgeBase(false)
      }
    }
  }, [])

  // Fetch full knowledge base data when dialog opens
  useEffect(() => {
    if (open && knowledgeBase?.id) {
      void loadFullKnowledgeBase(knowledgeBase.id)
    } else {
      fullKnowledgeBaseRequestId.current += 1
      setFullKnowledgeBase(null)
      setIsLoadingFullKnowledgeBase(false)
      setFullKnowledgeBaseLoadFailed(false)
    }

    return () => {
      fullKnowledgeBaseRequestId.current += 1
    }
  }, [open, knowledgeBase?.id, loadFullKnowledgeBase])

  // Initialize form fields when full data is loaded
  useEffect(() => {
    if (fullKnowledgeBase) {
      const kb = fullKnowledgeBase
      setName(kb.name)
      setDescription(kb.description || '')
      setDirectAccessRequirement(kb.direct_access_requirement ?? 'read')
      setSummaryEnabled(kb.summary_enabled || false)
      setSummaryModelRef(kb.summary_model_ref || null)
      setSummaryModelError('')
      loadMultimodalFromKB({
        multimodalAnalysisEnabled: kb.multimodal_analysis_enabled || false,
        multimodalAnalysisModelRef: kb.multimodal_analysis_model_ref || null,
        multimodalAnalysisModelError: '',
        multimodalVideoPrompt: kb.multimodal_analysis_video_prompt ?? null,
        multimodalImagePrompt: kb.multimodal_analysis_image_prompt ?? null,
      })
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
  }, [fullKnowledgeBase])

  const handleRetrievalConfigChange = useCallback((config: RetrievalConfigDraft) => {
    setRetrievalConfig(config)
  }, [])

  const handleSubmit = async () => {
    setError('')
    setSummaryModelError('')
    clearMultimodalError()

    if (!fullKnowledgeBase) {
      return
    }

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

    // Validate multimodal analysis model when multimodal analysis is enabled
    if (!validateMultimodal()) {
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
      const kb = fullKnowledgeBase
      const updateData: KnowledgeBaseUpdate = {
        name: name.trim(),
        description: description.trim(), // Allow empty string to clear description
        direct_access_requirement: directAccessRequirement,
        summary_enabled: summaryEnabled,
        summary_model_ref: summaryEnabled ? summaryModelRef : null,
        ...buildMultimodalSubmitFields(),
        // For edit, send "" (never null) so the backend always applies the value:
        // a blank string clears the override (revert to system default).
        multimodal_analysis_video_prompt: effectiveMultimodalEnabled
          ? multimodalVideoPrompt || ''
          : '',
        multimodal_analysis_image_prompt: effectiveMultimodalEnabled
          ? multimodalImagePrompt || ''
          : '',
        guided_questions: validGuidedQuestions,
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
      clearMultimodalError()
    }
    onOpenChange(newOpen)
  }

  // Knowledge base type info - use fullKnowledgeBase for accurate data
  const kb = fullKnowledgeBase
  const kbType = kb?.kb_type || 'notebook'
  const isNotebook = kbType === 'notebook'

  // Handle default opening view update success
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
            {isLoadingFullKnowledgeBase ? (
              <Spinner
                center
                text={tKnowledge('document.knowledgeBase.loadingDetails')}
                data-testid="edit-knowledge-base-loading"
              />
            ) : fullKnowledgeBaseLoadFailed ? (
              <div
                className="flex min-h-[200px] flex-col items-center justify-center gap-4 text-center"
                data-testid="edit-knowledge-base-load-error"
              >
                <p className="text-sm text-error">
                  {tKnowledge('document.knowledgeBase.loadDetailsFailed')}
                </p>
                <Button
                  variant="outline"
                  onClick={() => knowledgeBase?.id && loadFullKnowledgeBase(knowledgeBase.id)}
                  data-testid="edit-knowledge-base-retry"
                >
                  {tKnowledge('document.knowledgeBase.retryLoadDetails')}
                </Button>
              </div>
            ) : fullKnowledgeBase ? (
              <>
                <KnowledgeBaseForm
                  name={name}
                  description={description}
                  onNameChange={value => setName(value)}
                  onDescriptionChange={value => setDescription(value)}
                  directAccessRequirement={directAccessRequirement}
                  onDirectAccessRequirementChange={setDirectAccessRequirement}
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
                  {...multimodalFormProps}
                  knowledgeDefaultTeamId={
                    !kb?.summary_model_ref ? knowledgeDefaultTeamId : undefined
                  }
                  bindModel={bindModel}
                  callLimits={{ maxCalls, exemptCalls }}
                  onCallLimitsChange={({ maxCalls: nextMax, exemptCalls: nextExempt }) => {
                    setMaxCalls(nextMax)
                    setExemptCalls(nextExempt)
                  }}
                  advancedOpen={showAdvanced}
                  onAdvancedOpenChange={setShowAdvanced}
                  showRetrievalSection={!!kb?.retrieval_config}
                  retrievalConfig={retrievalConfig}
                  onRetrievalConfigChange={handleRetrievalConfigChange}
                  retrievalReadOnly={false}
                  retrievalPartialReadOnly={true}
                  showGuidedQuestions={true}
                  guidedQuestions={guidedQuestions}
                  onGuidedQuestionsChange={setGuidedQuestions}
                />

                {/* Default opening view section */}
                <div className="border-t border-border pt-4 mt-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {isNotebook ? (
                        <BookOpen className="w-4 h-4 text-primary" />
                      ) : (
                        <Database className="w-4 h-4 text-text-secondary" />
                      )}
                      <span className="text-sm font-medium">
                        {tKnowledge('document.knowledgeBase.currentDefaultView')}:{' '}
                        {isNotebook
                          ? tKnowledge('document.knowledgeBase.typeNotebook')
                          : tKnowledge('document.knowledgeBase.typeClassic')}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowConvertDialog(true)}
                      className="flex items-center gap-1.5"
                    >
                      {tKnowledge('document.knowledgeBase.changeDefaultView')}
                    </Button>
                  </div>
                </div>

                {error && <p className="text-sm text-error">{error}</p>}
              </>
            ) : null}
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
              disabled={loading || isLoadingFullKnowledgeBase || !fullKnowledgeBase}
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
        knowledgeBase={fullKnowledgeBase}
        onSuccess={handleTypeConverted}
      />
    </>
  )
}
